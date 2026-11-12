/**
 * API keys live ONLY in %APPDATA%/Clipwright Studio/secrets.bin, encrypted
 * with Electron safeStorage. If safeStorage is unavailable, keys stay in
 * memory for the session and are never written to disk.
 */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class SecretStore {
  private file: string;
  private memoryOnly = false;
  private sessionKeys = new Map<string, string>();

  constructor(appDataDir: string) {
    mkdirSync(appDataDir, { recursive: true });
    this.file = join(appDataDir, 'secrets.bin');
    this.memoryOnly = !safeStorage.isEncryptionAvailable();
  }

  get isMemoryOnly(): boolean { return this.memoryOnly; }

  private readAll(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const raw = readFileSync(this.file);
      const json = safeStorage.decryptString(raw);
      return JSON.parse(json) as Record<string, string>;
    } catch {
      return {}; // corrupt store — do not crash; treat as empty
    }
  }

  private writeAll(map: Record<string, string>): void {
    if (this.memoryOnly) return;
    writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(map)));
  }

  /** Store a secret; returns its stable secret id. */
  setSecret(value: string, secretId?: string): string {
    const id = secretId ?? randomUUID();
    if (this.memoryOnly) { this.sessionKeys.set(id, value); return id; }
    const all = this.readAll();
    all[id] = value;
    this.writeAll(all);
    return id;
  }

  getSecret(secretId: string): string | null {
    if (this.memoryOnly) return this.sessionKeys.get(secretId) ?? null;
    return this.readAll()[secretId] ?? null;
  }

  deleteSecret(secretId: string): void {
    if (this.memoryOnly) { this.sessionKeys.delete(secretId); return; }
    const all = this.readAll();
    delete all[secretId];
    this.writeAll(all);
  }

  hasSecret(secretId: string): boolean {
    return this.getSecret(secretId) !== null;
  }

  /** Masked suffix for display, e.g. ••••a1b2 */
  maskedSuffix(secretId: string): string | null {
    const v = this.getSecret(secretId);
    if (!v) return null;
    return '••••' + v.slice(-4);
  }
}
