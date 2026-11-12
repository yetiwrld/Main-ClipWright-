/**
 * Central logging with secret redaction. JSON lines, daily rotation,
 * 14-day / 50 MB retention. Never log transcript text or media content.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SECRET_PATTERNS: RegExp[] = [
  /authorization\s*[:=]\s*(bearer\s+)?[^\s,;"']+/gi,
  /api[-_]?key\s*[:=]\s*[^\s,;"']+/gi,
  /bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /sk-[A-Za-z0-9\-]{8,}/g,
  /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, // JWTs
  /(?:password|passwd|secret|token)\s*[:=]\s*[^\s,;"']+/gi,
  /cookie\s*[:=]\s*[^\n;]+/gi,
  /[A-Za-z0-9+/]{64,}={0,2}/g, // long base64 blobs
];

export const redact = (input: string): string => {
  let out = input;
  for (const pat of SECRET_PATTERNS) out = out.replace(pat, (m) => `[redacted ${m.split(/[:=\s]/)[0]}]`);
  // shorten home directory paths
  const home = homedir();
  if (home && out.includes(home)) out = out.split(home).join('~');
  return out;
};

export class Logger {
  private dir: string;
  private currentFile: string | null = null;
  private bytesWritten = 0;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.rotate();
  }

  private dayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private rotate(): void {
    const file = join(this.dir, `app-${this.dayKey()}.log`);
    if (this.currentFile === file && existsSync(file)) {
      this.bytesWritten = statSync(file).size;
      return;
    }
    this.currentFile = file;
    this.bytesWritten = existsSync(file) ? statSync(file).size : 0;
    this.enforceRetention();
  }

  private enforceRetention(): void {
    try {
      const files = readdirSync(this.dir).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
      const maxAgeMs = 14 * 24 * 3600 * 1000;
      const now = Date.now();
      let total = 0;
      const sized = files.map((f) => ({ f, size: statSync(join(this.dir, f)).size, mtime: statSync(join(this.dir, f)).mtimeMs }));
      for (const s of sized) { total += s.size; if (now - s.mtime > maxAgeMs) { try { unlinkSync(join(this.dir, s.f)); } catch { /* keep */ } } }
      // drop oldest until under 50 MB
      for (const s of sized) {
        if (total <= 50 * 1024 * 1024) break;
        total -= s.size;
        try { unlinkSync(join(this.dir, s.f)); } catch { /* keep */ }
      }
    } catch { /* retention is best-effort */ }
  }

  write(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
    this.rotate();
    const cleanFields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]));
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: redact(message), ...cleanFields }) + '\n';
    try {
      appendFileSync(this.currentFile!, line, 'utf8');
      this.bytesWritten += line.length;
    } catch { /* never crash on logging */ }
  }

  info(msg: string, fields?: Record<string, unknown>): void { this.write('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.write('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.write('error', msg, fields); }
}

export const createLogger = (logsDir: string): Logger => new Logger(logsDir);
