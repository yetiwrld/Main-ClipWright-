#!/usr/bin/env node
/**
 * SPEC 15 §8.2 step 8 — verify what was actually published.
 *
 * Everything before this step trusts local files. This step re-downloads the
 * assets from the public release URLs and checks them again, because the
 * failures this catches only exist after upload: a truncated upload, an asset
 * that got the wrong content type, a `latest.yml` that does not name the file
 * the app will look for, or a signature that no longer matches the published
 * manifest bytes.
 *
 * A release that fails here stays a draft.
 *
 * This script imports the app's own verification code (TypeScript source), so it
 * must run through tsx, not plain node:
 *
 *   pnpm tsx scripts/release/verify-published.mjs --tag v1.3.0
 *
 * That is deliberate — verifying with the *same* code the app uses is the point.
 * A separate reimplementation here could pass while the app rejects the release.
 */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'dist', 'release');

const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const tag = tagIndex >= 0 ? args[tagIndex + 1] : process.env.TAG;

if (!tag) fail('No tag given. Pass --tag vX.Y.Z or set TAG.');

const publicKey = process.env.UPDATE_PUBLIC_KEY_B64?.trim();
if (!publicKey) {
  fail(
    'UPDATE_PUBLIC_KEY_B64 is not set (repository variable). Without it there is no way to prove the published manifest verifies.',
  );
}

const repo = process.env.GITHUB_REPOSITORY ?? 'yetiwrld/Main-ClipWright-';
const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;

// ---- 1. The published manifest must parse, and its signature must verify with
// only the key embedded in the app.
console.log(`== Fetching ${baseUrl}/release-manifest.json`);
const manifestText = await fetchText(`${baseUrl}/release-manifest.json`);
const signature = await fetchText(`${baseUrl}/release-manifest.json.sig`);

const { parseReleaseManifest, verifyManifestSignature, evaluateVerification } =
  await import('@clipwright/update-core').catch(() => ({}));

if (!parseReleaseManifest) {
  fail('Could not import @clipwright/update-core. Run this through tsx: pnpm tsx scripts/release/verify-published.mjs');
}

const parsed = parseReleaseManifest(manifestText);
if (!parsed.ok) fail(`The published manifest does not parse: ${parsed.problem}`);

const signatureCheck = verifyManifestSignature(manifestText, signature, { current: publicKey });
if (!signatureCheck.ok) {
  fail(
    `The published manifest does not verify with the embedded public key (${signatureCheck.reason}). ` +
      'Every installed app would refuse this release.',
  );
}
console.log(`   signature verified (key: ${signatureCheck.key})`);

// ---- 2. Every listed file must be downloadable with the promised size.
for (const file of parsed.manifest.files) {
  console.log(`== Checking ${file.name}`);
  const response = await fetchOrFail(`${baseUrl}/${file.name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== file.size) {
    fail(`${file.name} is ${bytes.byteLength} bytes on the release page, not ${file.size}.`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== file.sha256) {
    fail(`${file.name} does not match the signed sha256. The uploaded file is not the one that was signed.`);
  }
  console.log(`   ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB, sha256 matches`);
}

// ---- 3. latest.yml must name the files the app will actually fetch.
console.log('== Checking latest.yml');
const latestText = await fetchText(`${baseUrl}/latest.yml`);
const { parseLatestYml } = await import(
  '../../apps/desktop/src/main/updater/update-service.ts'
).catch(() => ({}));
if (!parseLatestYml) fail('Could not import the latest.yml parser.');

const latest = parseLatestYml(latestText);
if (!latest) fail('latest.yml on the release does not parse.');

const verdict = evaluateVerification({
  manifest: parsed.manifest,
  signatureValid: true,
  signaturePresent: true,
  latest,
  now: Date.now(),
});
if (!verdict.ok) {
  fail(`The published latest.yml disagrees with the signed manifest (${verdict.stage}).`);
}
if (verdict.stale) {
  console.warn('   warning: the manifest is more than a year old.');
}
console.log('   latest.yml agrees with the signed manifest');

// ---- 4. SHA256SUMS.txt must match too, since the README tells users to check it.
const sums = await fetchText(`${baseUrl}/SHA256SUMS.txt`).catch(() => '');
if (sums) {
  for (const file of parsed.manifest.files) {
    const line = sums.split('\n').find((entry) => entry.trim().endsWith(file.name));
    if (!line) {
      fail(`SHA256SUMS.txt does not list ${file.name}.`);
    }
    if (!line.startsWith(file.sha256)) {
      fail(`SHA256SUMS.txt has the wrong digest for ${file.name}.`);
    }
  }
  console.log('   SHA256SUMS.txt matches');
} else {
  console.warn('   warning: SHA256SUMS.txt was not found on the release.');
}

console.log(`\nverify-published: OK — ${tag} is published, signed and consistent.\n`);

/* ------------------------------------------------------------------ */

async function fetchText(url) {
  const response = await fetchOrFail(url);
  return response.text();
}

/**
 * One place that turns a network failure into a readable reason.
 *
 * The first version let a TLS error escape as an unhandled rejection with a
 * stack trace, which is exactly what §4.1 forbids in the app and is no better in
 * a release log: the person reading it needs to know *which* URL failed and
 * whether the cause is likely to be local.
 */
async function fetchOrFail(url) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) fail(`HTTP ${response.status} fetching ${url}`);
    return response;
  } catch (error) {
    if (error?.name === 'UpdateVerificationError' || /^HTTP \d+/.test(error?.message ?? '')) throw error;
    const code = error?.cause?.code ?? error?.code ?? '';
    const hint =
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN'
        ? 'The TLS certificate could not be verified. That is usually a corporate proxy; this script never disables certificate checks.'
        : code === 'ENOTFOUND' || code === 'ECONNREFUSED'
          ? 'The network could not reach GitHub.'
          : error?.message ?? 'unknown error';
    fail(`Could not fetch ${url}\n  ${hint}`);
  }
}

function fail(message) {
  console.error(`\nverify-published: ${message}\n`);
  process.exit(1);
}
