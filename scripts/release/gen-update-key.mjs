#!/usr/bin/env node
/**
 * SPEC 15 §5 — generate the Ed25519 key pair used to sign release manifests.
 *
 * Run once, by the project owner, on a machine you trust:
 *
 *   node scripts/release/gen-update-key.mjs
 *
 * It prints two things:
 *
 *   1. the **public** key, base64 — paste it into
 *      `apps/desktop/src/main/updater/update-config.ts` as `EMBEDDED_UPDATE_KEYS.current`
 *      and commit it. It is public by design.
 *
 *   2. the **private** key, PKCS#8 PEM — store it as the GitHub Actions secret
 *      `UPDATE_SIGNING_KEY` and then delete any copy you have locally. It must
 *      never be committed, pasted into an issue, or stored in the workspace.
 *
 * Rotation (§5): generate a second pair, set the new public key as
 * `EMBEDDED_UPDATE_KEYS.next` and ship that release signed with the *old* key.
 * From then on the app accepts either. Sign the next release with the new key,
 * then promote `next` to `current`.
 */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

// Raw 32-byte key, base64: the shortest form the app accepts, and the least
// likely to be mangled by a YAML/JSON secret store.
const spki = publicKey.export({ type: 'spki', format: 'der' });
const rawBase64 = spki.subarray(spki.length - 32).toString('base64');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

console.log('');
console.log('=========================================================');
console.log(' PUBLIC KEY  — commit this');
console.log('=========================================================');
console.log('');
console.log(`  EMBEDDED_UPDATE_KEYS.current = '${rawBase64}'`);
console.log('');
console.log('=========================================================');
console.log(' PRIVATE KEY — GitHub secret UPDATE_SIGNING_KEY');
console.log('=========================================================');
console.log('');
console.log(pem.trimEnd());
console.log('');
console.log('Store the private key at:');
console.log('  Settings -> Secrets and variables -> Actions -> New repository secret');
console.log('  Name: UPDATE_SIGNING_KEY');
console.log('');
console.log('Then delete it from this machine and clear your shell history.');
console.log('');
console.log('If this output has ever been pasted into a chat, an issue, a log or a');
console.log('recording, discard this pair and generate a new one: a posted private');
console.log('key means anyone can sign a "release" your users will install.');
console.log('Until a real public key is embedded, every update is refused');
console.log('(by design — an unverifiable update is never installed).');
console.log('');
