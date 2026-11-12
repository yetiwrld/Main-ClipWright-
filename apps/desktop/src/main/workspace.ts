/**
 * Workspace folder layout + SQLite setup and forward-only migrations.
 * Two databases: workspace.db (index) and per-project project.cwdb.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_MIGRATIONS, PROJECT_MIGRATIONS, type Migration } from '@clipwright/project-schema';
import { newId } from '@clipwright/project-schema';

export const WORKSPACE_FOLDERS = [
  'Projects', 'Media', 'Proxies', 'Clips', 'Exports', 'Cache',
  'Models', 'Recovery', 'Logs', 'CaptionStyles', 'Templates', 'BrandKits', 'Fonts', 'Backups', 'Updates',
] as const;

export interface WorkspaceInfo {
  root: string;
  projectCount: number;
  schemaVersion: number;
}

export const defaultWorkspaceFolder = (): string => {
  // Documents\Clipwright Studio on Windows; ~/Documents/Clipwright Studio elsewhere
  const docs = join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', 'Documents', 'Clipwright Studio');
  return docs;
};

export const initWorkspace = (root: string): WorkspaceInfo => {
  mkdirSync(root, { recursive: true });
  for (const folder of WORKSPACE_FOLDERS) mkdirSync(join(root, folder), { recursive: true });
  const readmePath = join(root, 'README.txt');
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath,
      'This folder is your Clipwright Studio workspace.\n' +
      'Projects/, Media/, Exports/ and Models/ live here. Clipwright never deletes referenced media.\n' +
      'Do not move or rename this folder while the app is running.\n', 'utf8');
  }
  const marker = join(root, 'workspace.json');
  if (!existsSync(marker)) {
    writeFileSync(marker, JSON.stringify({ format: 'clipwright-workspace', formatVersion: 1, id: newId(), createdAt: Date.now() }, null, 2), 'utf8');
  }
  const db = openWorkspaceDb(root);
  db.close();
  return { root, projectCount: 0, schemaVersion: WORKSPACE_MIGRATIONS.length };
};

export const isWorkspace = (root: string): boolean => existsSync(join(root, 'workspace.json'));

export const backupBeforeMigration = (dbPath: string, backupsDir: string, schemaVersion: number): void => {
  if (!existsSync(dbPath) || schemaVersion <= 0) return;
  mkdirSync(backupsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    cpSync(dbPath, join(backupsDir, `pre-v${schemaVersion}-${ts}.cwdb`));
  } catch { /* if we cannot back up, caller still proceeds — the file itself is untouched */ }
};

const applyMigrations = (db: Database.Database, migrations: readonly Migration[], dbPath: string, backupsDir: string): void => {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const applied = new Set((db.prepare('SELECT version FROM _migrations').all() as Array<{ version: number }>).map((r) => r.version));
  const current = applied.size ? Math.max(...applied) : 0;
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return;
  backupBeforeMigration(dbPath, backupsDir, current);
  const runAll = db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations(version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
    }
  });
  runAll();
  // post-migration integrity checks
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  if (integrity !== 'ok') {
    throw new Error(`Database integrity check failed after migration: ${integrity}`);
  }
};

export const openWorkspaceDb = (root: string): Database.Database => {
  const dbPath = join(root, 'workspace.db');
  const db = new Database(dbPath);
  applyMigrations(db, WORKSPACE_MIGRATIONS, dbPath, join(root, 'Backups', 'workspace'));
  return db;
};

export const createProjectDb = (root: string, projectId: string): Database.Database => {
  const dir = join(root, 'Projects', projectId);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'project.cwdb');
  const db = new Database(dbPath);
  applyMigrations(db, PROJECT_MIGRATIONS, dbPath, join(root, 'Backups', projectId));
  return db;
};

export const openProjectDb = (root: string, projectId: string): Database.Database => {
  const dbPath = join(root, 'Projects', projectId, 'project.cwdb');
  if (!existsSync(dbPath)) throw new Error(`Project database not found for project ${projectId}`);
  const db = new Database(dbPath);
  applyMigrations(db, PROJECT_MIGRATIONS, dbPath, join(root, 'Backups', projectId));
  return db;
};

export const projectFolder = (root: string, projectId: string): string => join(root, 'Projects', projectId);
export const mediaFolder = (root: string, mediaId: string): string => join(root, 'Media', mediaId);
export const recoveryFolder = (root: string, projectId: string): string => join(root, 'Recovery', projectId);
export const workspaceLogs = (root: string): string => join(root, 'Logs');
