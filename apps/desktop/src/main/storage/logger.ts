import fs from 'node:fs';
import path from 'node:path';
import { redact } from '@clipwright/project-schema';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export class Logger {
  private logsDir: string;
  private debugEnabled: boolean;

  constructor(logsDir: string, debugEnabled = false) {
    this.logsDir = logsDir;
    this.debugEnabled = debugEnabled;
    fs.mkdirSync(this.logsDir, { recursive: true });
    fs.mkdirSync(path.join(this.logsDir, 'crash'), { recursive: true });
  }

  public setLogsDir(logsDir: string): void {
    this.logsDir = logsDir;
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  public log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (level === 'debug' && !this.debugEnabled) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    const logPath = path.join(this.logsDir, `app-${dateStr}.log`);

    const rawEntry = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      meta: meta ? JSON.parse(redact(JSON.stringify(meta))) : undefined,
    });
    const safeLine = redact(rawEntry) + '\n';

    try {
      fs.appendFileSync(logPath, safeLine, 'utf8');
    } catch {
      // Never crash if disk is full during logging
    }
  }

  public info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  public warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  public error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }

  public debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  public getRecentLines(limit = 200): string[] {
    const dateStr = new Date().toISOString().slice(0, 10);
    const logPath = path.join(this.logsDir, `app-${dateStr}.log`);
    if (!fs.existsSync(logPath)) return [];
    const content = fs.readFileSync(logPath, 'utf8').trim();
    if (!content) return [];
    const lines = content.split('\n');
    return lines.slice(-limit);
  }
}
