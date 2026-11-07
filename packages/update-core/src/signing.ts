/**
 * SPEC 15 §5 — Ed25519 detached signatures over the release manifest.
 *
 * The private key exists only as the GitHub Actions secret `UPDATE_SIGNING_KEY`
 * and never enters this repository or the app. What ships in the app is a
 * *public* key (plus a next key, so a key can be rotated before the old one is
 * retired — §5 "key management").
 *
 * The app accepts a signature from **either** the current or the next public
 * key. That is what makes rotation possible: release N ships the new public
 * key, and releases N+1.. are signed with the new private key while users who
 * have not yet updated still accept the old one.
 *
 * Depends on node:crypto only; the caller decides which keys are trusted.
 */
import { createPublicKey, verify as cryptoVerify, sign as cryptoSign } from 'node:crypto';

/** The set of public keys this build will accept, most recent first. */
export interface TrustedKeys {
  /** Base64 SPKI PEM or raw 32-byte base64; see `normalisePublicKey`. */
  current: string;
  /** Acceptable during a rotation window (§5). Absent when not rotating. */
  next?: string;
}

export type SignatureCheck =
  | { ok: true; key: 'current' | 'next' }
  | { ok: false; reason: 'missing' | 'malformed' | 'unknown-key' | 'invalid' };

/**
 * Accept a PEM, a base64 SPKI body, or a raw 32-byte base64 key, and return a
 * KeyObject. Returns null when the value is not a usable Ed25519 public key —
 * callers must treat that as "cannot verify", never as "verified".
 */
function toPublicKey(value: string): ReturnType<typeof createPublicKey> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.includes('BEGIN PUBLIC KEY')) {
      const key = createPublicKey(trimmed);
      return key.asymmetricKeyType === 'ed25519' ? key : null;
    }
    // Bare base64: could be a DER SPKI blob or a raw 32-byte key.
    const buffer = Buffer.from(trimmed, 'base64');
    const candidates: Buffer[] = [];
    if (buffer.length === 32) {
      // Raw Ed25519 key: wrap in the fixed SPKI prefix so node accepts it.
      candidates.push(
        Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), buffer]),
      );
    } else {
      candidates.push(buffer);
    }
    for (const der of candidates) {
      try {
        const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
        if (key.asymmetricKeyType === 'ed25519') return key;
      } catch {
        // try the next candidate
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** True when the value parses as an Ed25519 public key we could trust. */
export function isValidPublicKey(value: string): boolean {
  return toPublicKey(value) !== null;
}

/**
 * Verify a detached signature over the manifest bytes.
 *
 * @param manifestText exact bytes that were signed (never a re-serialisation:
 *                     re-encoding JSON would invalidate an honest signature)
 * @param signatureBase64 the contents of `release-manifest.json.sig`
 * @param keys          trusted public keys
 */
export function verifyManifestSignature(
  manifestText: string,
  signatureBase64: string,
  keys: TrustedKeys,
): SignatureCheck {
  if (!signatureBase64 || !signatureBase64.trim()) return { ok: false, reason: 'missing' };

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64.trim(), 'base64');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  // Ed25519 signatures are always 64 bytes.
  if (signature.length !== 64) return { ok: false, reason: 'malformed' };

  const data = Buffer.from(manifestText, 'utf8');
  const order: Array<'current' | 'next'> = keys.next ? ['current', 'next'] : ['current'];
  let sawUsableKey = false;

  for (const slot of order) {
    const encoded = slot === 'current' ? keys.current : keys.next;
    if (!encoded) continue;
    const key = toPublicKey(encoded);
    if (!key) continue;
    sawUsableKey = true;
    try {
      if (cryptoVerify(null, data, key, signature)) return { ok: true, key: slot };
    } catch {
      // A verification error is a failed signature, not a crash.
    }
  }

  return { ok: false, reason: sawUsableKey ? 'invalid' : 'unknown-key' };
}

/**
 * Produce a signature. Only the release pipeline calls this (with the secret
 * key from `UPDATE_SIGNING_KEY`); the app never has a private key.
 */
export function signManifest(manifestText: string, privateKeyPem: string): string {
  return cryptoSign(null, Buffer.from(manifestText, 'utf8'), privateKeyPem).toString('base64');
}

/**
 * The manifest must be hashed and signed as the exact bytes published. CI writes
 * it with this function so the app can verify without re-serialising first.
 */
export function serialiseManifest(manifest: Record<string, unknown>): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
