/**
 * Crash recovery: lock files + append-only journal + checkpoints.
 * Journal lines are full composition snapshots (small documents) — replay
 * keeps the newest per composition. Bad lines are quarantined, never fatal.
 * (Simplification of the patch-based journal, recorded in docs/decisions.md.)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { CompositionSchema, type Composition } from '@clipwright/project-schema';

export interface LockInfo { pid: number; startedAt: number; heartbeatAt: number; hostname: string; appVersion: string; }
export interface JournalLine { seq: number; compId: string; ts: number; kind: 'checkpoint'; comp: Composition; }

const heartbeatPath = (dir: string) => join(dir, 'lock.json');
const journalPath = (dir: string) => join(dir, 'journal.jsonl');
export const recoveryDir = (root: string, projectId: string) => join(root, 'Recovery', projectId);

export const writeLock = (dir: string, appVersion: string): LockInfo => {
  mkdirSync(dir, { recursive: true });
  const info: LockInfo = { pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now(), hostname: hostname(), appVersion };
  writeFileSync(heartbeatPath(dir), JSON.stringify(info), 'utf8');
  return info;
};

export const refreshLock = (dir: string): void => {
  const path = heartbeatPath(dir);
  if (!existsSync(path)) return;
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
    info.heartbeatAt = Date.now();
    writeFileSync(path, JSON.stringify(info), 'utf8');
  } catch { /* stale lock will be detected next open */ }
};

export const removeLock = (dir: string): void => {
  try { unlinkSync(heartbeatPath(dir)); } catch { /* already gone */ }
};

export interface LockStatus {
  state: 'none' | 'alive' | 'stale';
  info?: LockInfo;
}

export const lockStatus = (dir: string): LockStatus => {
  const path = heartbeatPath(dir);
  if (!existsSync(path)) return { state: 'none' };
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
    const fresh = Date.now() - info.heartbeatAt < 15_000;
    let pidAlive = false;
    try { process.kill(info.pid, 0); pidAlive = true; } catch { pidAlive = false; }
    // same host + alive + fresh heartbeat => alive; otherwise stale
    if (fresh && pidAlive && info.hostname === hostname()) return { state: 'alive', info };
    return { state: 'stale', info };
  } catch {
    return { state: 'stale' };
  }
};

export class Journal {
  private dir: string;
  private seq: number;
  private pending = 0;
  private lastFlush = 0;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.seq = this.countLines();
  }

  private countLines(): number {
    const path = journalPath(this.dir);
    if (!existsSync(path)) return 0;
    try {
      const raw = readFileSync(path, 'utf8');
      return raw.split('\n').filter((l) => l.trim().length > 0).length;
    } catch { return 0; }
  }

  append(comp: Composition): number {
    const seq = this.seq + 1;
    const line: JournalLine = { seq, compId: comp.id, ts: Date.now(), kind: 'checkpoint', comp };
    appendFileSync(journalPath(this.dir), JSON.stringify(line) + '\n', 'utf8');
    this.seq = seq;
    this.pending += 1;
    this.maybeFlush();
    return seq;
  }

  /** fsync at most once per second; callers may force. */
  private maybeFlush(force = false): void {
    const nowT = Date.now();
    if (!force && nowT - this.lastFlush < 1000) return;
    try {
      const fd = openSync(journalPath(this.dir), 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      this.lastFlush = nowT;
      this.pending = 0;
    } catch { /* best effort */ }
  }

  flush(): void { this.maybeFlush(true); }

  /** Read journaled compositions, newest per composition id; quarantines bad lines. */
  readRecoverable(): { comps: Map<string, Composition>; badLines: number } {
    const path = journalPath(this.dir);
    const comps = new Map<string, Composition>();
    let badLines = 0;
    if (!existsSync(path)) return { comps, badLines };
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JournalLine;
        const comp = CompositionSchema.parse(parsed.comp);
        comps.set(comp.id, comp);
      } catch {
        badLines += 1;
      }
    }
    return { comps, badLines };
  }

  clear(): void {
    try { unlinkSync(journalPath(this.dir)); } catch { /* absent */ }
    this.seq = 0;
  }

  get pendingEntries(): number { return this.pending; }
}

/** Snapshots in Recovery/<id>/checkpoints/<ts>.cwcp — keep last 20 + ride-along. */
export const saveRestorePoint = (dir: string, projectId: string, payload: unknown): string => {
  const cpDir = join(dir, 'checkpoints');
  mkdirSync(cpDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(cpDir, `${ts}.cwcp`);
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  // prune: keep last 20 and one per day
  const files = readdirSync(cpDir).filter((f) => f.endsWith('.cwcp')).sort().reverse();
  const keep = new Set(files.slice(0, 20));
  const seenDays = new Set<string>();
  for (const f of files) {
    const day = f.slice(0, 10);
    if (!seenDays.has(day)) { keep.add(f); seenDays.add(day); }
  }
  for (const f of files) if (!keep.has(f)) { try { unlinkSync(join(cpDir, f)); } catch { /* keep */ } }
  return path;
};
