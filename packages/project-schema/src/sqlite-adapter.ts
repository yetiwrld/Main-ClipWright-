import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface StatementAdapter {
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: <T = Record<string, unknown>>(...params: unknown[]) => T | undefined;
  all: <T = Record<string, unknown>>(...params: unknown[]) => T[];
}

export interface SqliteDatabase {
  readonly filePath: string;
  exec: (sql: string) => void;
  pragma: (expr: string, simplify?: boolean) => unknown;
  prepare: (sql: string) => StatementAdapter;
  transaction: <T extends (...args: any[]) => any>(fn: T) => T;
  backupTo: (destPath: string) => void;
  close: () => void;
}

class NodeSqliteAdapter implements SqliteDatabase {
  public readonly filePath: string;
  private db: any;
  private txDepth = 0;

  constructor(filePath: string, opts?: { readonly?: boolean; synchronous?: 'NORMAL' | 'FULL' }) {
    this.filePath = filePath;
    if (filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(filePath, {
      readOnly: opts?.readonly ?? false,
    });
    if (!opts?.readonly) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec(`PRAGMA synchronous = ${opts?.synchronous ?? 'NORMAL'};`);
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(expr: string, simplify = false): unknown {
    const stmt = this.db.prepare(`PRAGMA ${expr}`);
    if (expr.includes('=')) {
      stmt.run();
      return undefined;
    }
    const rows = stmt.all() as Array<Record<string, unknown>>;
    if (simplify && rows.length > 0) {
      const firstKey = Object.keys(rows[0])[0];
      return rows[0][firstKey];
    }
    return rows;
  }

  prepare(sql: string): StatementAdapter {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const res = stmt.run(...params);
        return {
          changes: Number(res.changes ?? 0),
          lastInsertRowid: res.lastInsertRowid ?? 0,
        };
      },
      get: <T = Record<string, unknown>>(...params: unknown[]): T | undefined => {
        const row = stmt.get(...params);
        return row ? ({ ...row } as T) : undefined;
      },
      all: <T = Record<string, unknown>>(...params: unknown[]): T[] => {
        const rows = stmt.all(...params) as Array<Record<string, unknown>>;
        return rows.map((r) => ({ ...r }) as T);
      },
    };
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    const wrapped = ((...args: any[]) => {
      const savepoint = `sp_${this.txDepth}`;
      if (this.txDepth === 0) {
        this.db.exec('BEGIN IMMEDIATE');
      } else {
        this.db.exec(`SAVEPOINT ${savepoint}`);
      }
      this.txDepth++;
      try {
        const result = fn(...args);
        this.txDepth--;
        if (this.txDepth === 0) {
          this.db.exec('COMMIT');
        } else {
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
        return result;
      } catch (err) {
        this.txDepth--;
        if (this.txDepth === 0) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            // ignore rollback error
          }
        } else {
          try {
            this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          } catch {
            // ignore
          }
        }
        throw err;
      }
    }) as T;
    return wrapped;
  }

  backupTo(destPath: string): void {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }
    const escaped = destPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
  }

  close(): void {
    this.db.close();
  }
}

export function openDatabase(
  filePath: string,
  opts?: { readonly?: boolean; synchronous?: 'NORMAL' | 'FULL' }
): SqliteDatabase {
  return new NodeSqliteAdapter(filePath, opts);
}
