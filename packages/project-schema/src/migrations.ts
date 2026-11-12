/**
 * Forward-only, numbered migrations for the two SQLite databases.
 * The SQL lives here (pure data) so both the desktop app and the test-suite
 * can apply them to a real database. Every migration must be idempotent when
 * applied after its predecessors, and each ships with a unit test.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** workspace.db — project index, media registry, jobs, settings, ... */
export const WORKSPACE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'workspace-initial',
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schemaVersion', '1');

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'created',
  archived INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL,
  source_media_id TEXT,
  source_url TEXT,
  thumbnail_path TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects(stage);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  storage_mode TEXT NOT NULL,
  path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  fingerprint TEXT NOT NULL,
  volume_id TEXT,
  info_json TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_fingerprint ON media(fingerprint);

CREATE TABLE IF NOT EXISTS derived_files (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'done',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_derived_media ON derived_files(media_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  project_id TEXT,
  media_id TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  priority TEXT NOT NULL DEFAULT 'background',
  progress REAL NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  error_technical TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  path TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  sha256 TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT,
  model TEXT,
  secret_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS caption_styles (id TEXT PRIMARY KEY, name TEXT NOT NULL, data_json TEXT NOT NULL, built_in INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS brand_kits (id TEXT PRIMARY KEY, name TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS _quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS export_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  comp_id TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  output_path TEXT NOT NULL,
  size_bytes INTEGER,
  duration_us INTEGER,
  validation_json TEXT,
  created_at INTEGER NOT NULL
);
`,
  },
];

/** project.cwdb — one per project. */
export const PROJECT_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'project-initial',
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schemaVersion', '1');

CREATE TABLE IF NOT EXISTS compositions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  fps INTEGER NOT NULL DEFAULT 30,
  width INTEGER NOT NULL DEFAULT 1080,
  height INTEGER NOT NULL DEFAULT 1920,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_words (
  id TEXT PRIMARY KEY,
  index_ INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  confidence REAL,
  speaker TEXT
);
CREATE INDEX IF NOT EXISTS idx_words_time ON transcript_words(start_us);

CREATE TABLE IF NOT EXISTS captions (
  id TEXT PRIMARY KEY,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  text TEXT NOT NULL,
  word_ids_json TEXT NOT NULL DEFAULT '[]',
  emphasis_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_captions_time ON captions(start_us);

CREATE TABLE IF NOT EXISTS moments (
  id TEXT PRIMARY KEY,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  score REAL NOT NULL,
  breakdown_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'candidate',
  stale INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moments_score ON moments(score DESC);

CREATE TABLE IF NOT EXISTS project_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS _quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
];

export const WORKSPACE_SCHEMA_VERSION = WORKSPACE_MIGRATIONS[WORKSPACE_MIGRATIONS.length - 1]!.version;
export const PROJECT_SCHEMA_VERSION = PROJECT_MIGRATIONS[PROJECT_MIGRATIONS.length - 1]!.version;
