import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SqliteDatabase, openDatabase } from './sqlite-adapter.js';
import { CURRENT_SCHEMA_VERSION } from './schemas.js';

export interface Migration {
  version: number;
  description: string;
  up: (db: SqliteDatabase) => void;
}

export const WORKSPACE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial workspace index, media registry, jobs, settings, models, providers',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS _meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS _quarantine (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_table TEXT NOT NULL,
          row_id TEXT NOT NULL,
          raw_json TEXT NOT NULL,
          error_message TEXT NOT NULL,
          quarantined_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          stage TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          storage_mode TEXT NOT NULL,
          path TEXT NOT NULL,
          original_name TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT,
          fingerprint TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ok',
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_media_fingerprint ON media(fingerprint);
        CREATE TABLE IF NOT EXISTS derived_files (
          id TEXT PRIMARY KEY,
          media_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          path TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          params_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_derived_media ON derived_files(media_id);
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          project_id TEXT,
          media_id TEXT,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 10,
          progress REAL NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 1,
          error TEXT,
          started_at TEXT,
          finished_at TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority);
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS models (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          throughput_factor REAL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          locality TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS consents (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          category TEXT NOT NULL,
          scope TEXT NOT NULL,
          granted_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS data_sent_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          provider_host TEXT NOT NULL,
          task TEXT NOT NULL,
          category TEXT NOT NULL,
          approx_bytes INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    description: 'Add caption_styles, brand_kits, and export_history tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS caption_styles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          source TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS brand_kits (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS export_history (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          comp_id TEXT NOT NULL,
          output_path TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
      `);
    },
  },
];

export const PROJECT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial project database schema (meta, compositions, items_index, transcript, moments)',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS _quarantine (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_table TEXT NOT NULL,
          row_id TEXT NOT NULL,
          raw_json TEXT NOT NULL,
          error_message TEXT NOT NULL,
          quarantined_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS compositions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS items_index (
          comp_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          track_id TEXT NOT NULL,
          start_us INTEGER NOT NULL,
          end_us INTEGER NOT NULL,
          media_id TEXT,
          PRIMARY KEY (comp_id, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_items_media ON items_index(media_id);
        CREATE TABLE IF NOT EXISTS transcript_words (
          id TEXT PRIMARY KEY,
          start_us INTEGER NOT NULL,
          end_us INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_words_start ON transcript_words(start_us);
        CREATE TABLE IF NOT EXISTS transcript_structure (
          id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS moments (
          id TEXT PRIMARY KEY,
          score INTEGER NOT NULL,
          start_us INTEGER NOT NULL,
          end_us INTEGER NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    description: 'Add caption_styles_used and history_checkpoints tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS caption_styles_used (
          id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS history_checkpoints (
          id TEXT PRIMARY KEY,
          label TEXT,
          named INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          file_path TEXT NOT NULL
        );
      `);
    },
  },
];

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  readOnly: boolean;
  readOnlyReason?: string;
  migrated: boolean;
  restoredFromBackup?: boolean;
  error?: string;
}

function getDbSchemaVersion(db: SqliteDatabase, isProjectDb: boolean): number {
  const tableName = isProjectDb ? 'meta' : '_meta';
  const colName = isProjectDb ? 'value_json' : 'value';
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get<{ name: string }>(tableName);
  if (!hasTable) return 0;

  const row = db
    .prepare(`SELECT ${colName} as val FROM ${tableName} WHERE key = 'schemaVersion'`)
    .get<{ val: string }>();
  if (!row) return 0;
  const parsed = Number(JSON.parse(row.val));
  return Number.isFinite(parsed) ? parsed : 0;
}

function setDbSchemaVersion(db: SqliteDatabase, version: number, isProjectDb: boolean): void {
  const tableName = isProjectDb ? 'meta' : '_meta';
  const colName = isProjectDb ? 'value_json' : 'value';
  db.prepare(
    `INSERT INTO ${tableName} (key, ${colName}) VALUES ('schemaVersion', ?)
     ON CONFLICT(key) DO UPDATE SET ${colName} = excluded.${colName}`
  ).run(JSON.stringify(version));
}

function pruneBackups(folder: string, keepCount = 3): void {
  if (!fs.existsSync(folder)) return;
  const files = fs
    .readdirSync(folder)
    .filter((f) => f.startsWith('pre-v'))
    .map((f) => ({
      name: f,
      full: path.join(folder, f),
      mtime: fs.statSync(path.join(folder, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of files.slice(keepCount)) {
    try {
      fs.unlinkSync(old.full);
    } catch {
      // ignore
    }
  }
}

export function runMigrations(
  db: SqliteDatabase,
  migrations: Migration[],
  opts: {
    isProjectDb: boolean;
    backupDir?: string;
    injectFailureAtVersion?: number;
  }
): MigrationResult {
  const currentVersion = getDbSchemaVersion(db, opts.isProjectDb);

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    return {
      fromVersion: currentVersion,
      toVersion: currentVersion,
      readOnly: true,
      readOnlyReason:
        'This project was made with a newer version of Clipwright Studio. Update the app to edit it.',
      migrated: false,
    };
  }

  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    return {
      fromVersion: currentVersion,
      toVersion: currentVersion,
      readOnly: false,
      migrated: false,
    };
  }

  // Backup before migrating (Spec 03 §9)
  let backupFile: string | undefined;
  if (opts.backupDir && currentVersion > 0 && db.filePath !== ':memory:') {
    fs.mkdirSync(opts.backupDir, { recursive: true });
    const ext = opts.isProjectDb ? 'cwdb' : 'db';
    backupFile = path.join(opts.backupDir, `pre-v${currentVersion}-${Date.now()}.${ext}`);
    db.backupTo(backupFile);
    pruneBackups(opts.backupDir, 3);
  }

  try {
    for (const mig of pending) {
      const tx = db.transaction(() => {
        mig.up(db);
        if (opts.injectFailureAtVersion === mig.version) {
          throw new Error(`Injected migration failure at version ${mig.version}`);
        }
        setDbSchemaVersion(db, mig.version, opts.isProjectDb);
      });
      tx();
    }

    // Integrity check (Spec 03 §9)
    const integrity = db.pragma('integrity_check', true);
    const fkErrors = db.pragma('foreign_key_check') as unknown[];
    if (integrity !== 'ok' || (Array.isArray(fkErrors) && fkErrors.length > 0)) {
      throw new Error(`Database integrity check failed after migration: ${String(integrity)}`);
    }

    const finalVersion = pending[pending.length - 1].version;
    return {
      fromVersion: currentVersion,
      toVersion: finalVersion,
      readOnly: false,
      migrated: true,
    };
  } catch (err: any) {
    // Restore from backup if available
    if (backupFile && fs.existsSync(backupFile) && db.filePath !== ':memory:') {
      const targetPath = db.filePath;
      db.close();
      fs.copyFileSync(backupFile, targetPath);
      return {
        fromVersion: currentVersion,
        toVersion: currentVersion,
        readOnly: false,
        migrated: false,
        restoredFromBackup: true,
        error: err?.message ?? String(err),
      };
    }
    throw err;
  }
}

export interface ValidatedQueryResult<T> {
  items: T[];
  quarantinedCount: number;
  recoveredWithProblems: boolean;
}

/**
 * Spec 03 §2.3: Validates every row's JSON column with zod on read.
 * Rows that fail validation are quarantined in `_quarantine` untouched.
 */
export function readValidatedRows<T>(
  db: SqliteDatabase,
  tableName: string,
  idColumn: string,
  jsonColumn: string,
  schema: z.ZodType<T, any, any>,
  whereClause = ''
): ValidatedQueryResult<T> {
  const rows = db
    .prepare(`SELECT ${idColumn} as id, ${jsonColumn} as json FROM ${tableName} ${whereClause}`)
    .all<{ id: string; json: string }>();

  const items: T[] = [];
  let quarantinedCount = 0;

  for (const row of rows) {
    try {
      const parsedJson = JSON.parse(row.json);
      const validated = schema.parse(parsedJson);
      items.push(validated);
    } catch (err: any) {
      quarantinedCount++;
      db.prepare(
        `INSERT INTO _quarantine (source_table, row_id, raw_json, error_message, quarantined_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        tableName,
        String(row.id),
        String(row.json),
        err?.message ?? 'Validation error',
        new Date().toISOString()
      );
      db.prepare(`DELETE FROM ${tableName} WHERE ${idColumn} = ?`).run(row.id);
    }
  }

  return {
    items,
    quarantinedCount,
    recoveredWithProblems: quarantinedCount > 0,
  };
}
