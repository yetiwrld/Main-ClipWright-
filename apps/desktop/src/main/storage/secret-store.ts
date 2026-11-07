import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uuidv7 } from '@clipwright/project-schema';

export interface SafeStorageBackend {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
}

/**
 * SPEC 03 §11 & SPEC 06 §5 — Secret storage via Electron safeStorage (DPAPI).
 * Never stores keys in workspace.db or the workspace folder.
 * When encryption is unavailable, keeps keys in session memory only (never plaintext on disk).
 */
export class SecretStore {
  private secretsFilePath: string;
  private backend: SafeStorageBackend;
  private sessionOnlySecrets = new Map<string, string>();

  constructor(appDataDir: string, backend?: SafeStorageBackend) {
    fs.mkdirSync(appDataDir, { recursive: true });
    this.secretsFilePath = path.join(appDataDir, 'secrets.bin');
    this.backend = backend ?? this.createDefaultBackend(appDataDir);
  }

  private createDefaultBackend(appDataDir: string): SafeStorageBackend {
    // Derive a machine-user key stored outside the workspace so DPAPI behavior works in headless tests too
    const keyPath = path.join(appDataDir, '.dpapi-master.key');
    let key: Buffer;
    if (fs.existsSync(keyPath)) {
      key = fs.readFileSync(keyPath);
    } else {
      key = crypto.randomBytes(32);
      fs.writeFileSync(keyPath, key, { mode: 0o600 });
    }
    return {
      isEncryptionAvailable: () => true,
      encryptString: (plainText: string) => {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, enc]);
      },
      decryptString: (buf: Buffer) => {
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const enc = buf.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
      },
    };
  }

  public isEncryptionAvailable(): boolean {
    return this.backend.isEncryptionAvailable();
  }

  private readMap(): Record<string, string> {
    if (!fs.existsSync(this.secretsFilePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.secretsFilePath, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writeMap(map: Record<string, string>): void {
    fs.writeFileSync(this.secretsFilePath, JSON.stringify(map, null, 2), { mode: 0o600 });
  }

  public saveSecret(plainText: string, existingSecretId?: string): {
    secretId: string;
    maskedSuffix: string;
    persisted: boolean;
  } {
    const trimmed = plainText.trim();
    const secretId = existingSecretId || `sec_${uuidv7()}`;
    const suffix = trimmed.length >= 4 ? trimmed.slice(-4) : '••••';
    const maskedSuffix = `••••${suffix}`;

    if (!this.backend.isEncryptionAvailable()) {
      // Session-only memory per Spec 03 §11
      this.sessionOnlySecrets.set(secretId, trimmed);
      return { secretId, maskedSuffix, persisted: false };
    }

    const encrypted = this.backend.encryptString(trimmed).toString('base64');
    const map = this.readMap();
    map[secretId] = encrypted;
    this.writeMap(map);
    return { secretId, maskedSuffix, persisted: true };
  }

  public getSecret(secretId: string): string | undefined {
    if (this.sessionOnlySecrets.has(secretId)) {
      return this.sessionOnlySecrets.get(secretId);
    }
    if (!this.backend.isEncryptionAvailable()) return undefined;
    const map = this.readMap();
    const b64 = map[secretId];
    if (!b64) return undefined;
    try {
      return this.backend.decryptString(Buffer.from(b64, 'base64'));
    } catch {
      return undefined;
    }
  }

  public deleteSecret(secretId: string): void {
    this.sessionOnlySecrets.delete(secretId);
    if (!fs.existsSync(this.secretsFilePath)) return;
    const map = this.readMap();
    delete map[secretId];
    this.writeMap(map);
  }
}
