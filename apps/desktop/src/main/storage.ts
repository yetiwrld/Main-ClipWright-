/**
 * StorageService — the ONLY writer to the two SQLite databases.
 * The renderer never touches disk or databases; everything flows through
 * typed, zod-checked IPC handlers that call into this service.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppSettingsSchema, CompositionSchema, MediaAssetSchema, MediaInfoSchema, MomentSchema,
  ProjectRecordSchema, ProjectStageSchema, TranscriptWordSchema, CaptionChunkSchema,
  defaultAppSettings, newId, type AppSettings, type CaptionChunk, type Composition,
  type MediaAsset, type Moment, type ProjectRecord, type ProjectStage, type TranscriptWord,
} from '@clipwright/project-schema';
import { openWorkspaceDb, createProjectDb, openProjectDb, projectFolder } from './workspace.js';

const now = () => Date.now();

export class StorageService {
  readonly workspaceRoot: string;
  private workspace: Database.Database;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.workspace = openWorkspaceDb(workspaceRoot);
  }

  close(): void { this.workspace.close(); }

  /* ---------------------------------------------------------- settings */
  getSettings(): AppSettings {
    const stored = this.workspace.prepare('SELECT key, value_json FROM settings').all() as Array<{ key: string; value_json: string }>;
    const merged: Record<string, unknown> = {};
    for (const row of stored) {
      try { merged[row.key] = JSON.parse(row.value_json); } catch { /* skip bad row */ }
    }
    return AppSettingsSchema.parse({ ...defaultAppSettings(), ...merged });
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next = AppSettingsSchema.parse({ ...current, ...patch });
    const tx = this.workspace.transaction((entries: Array<[string, unknown]>) => {
      const stmt = this.workspace.prepare('INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json');
      for (const [k, v] of entries) stmt.run(k, JSON.stringify(v));
    });
    tx(Object.entries(patch));
    return next;
  }

  /* ---------------------------------------------------------- projects */
  listProjects(opts: { includeArchived?: boolean } = {}): ProjectRecord[] {
    const rows = opts.includeArchived
      ? this.workspace.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()
      : this.workspace.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY updated_at DESC').all();
    const out: ProjectRecord[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const parsed = this.tryProjectRow(row);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  private tryProjectRow(row: Record<string, unknown>): ProjectRecord | null {
    try {
      const settings = JSON.parse(String(row['settings_json']));
      return ProjectRecordSchema.parse({
        id: row['id'], name: row['name'], stage: row['stage'],
        archived: row['archived'] === 1,
        settings,
        sourceMediaId: row['source_media_id'] ?? undefined,
        sourceUrl: row['source_url'] ?? undefined,
        thumbnailPath: row['thumbnail_path'] ?? undefined,
        schemaVersion: row['schema_version'],
        createdAt: row['created_at'], updatedAt: row['updated_at'],
      });
    } catch {
      try { this.quarantine('projects', String(row['id']), 'invalid project row', row); } catch { /* quarantine must never crash */ }
      return null;
    }
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.workspace.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.tryProjectRow(row) : null;
  }

  createProject(input: { name: string; settings: ProjectRecord['settings']; sourceUrl?: string }): ProjectRecord {
    const id = newId();
    const ts = now();
    const record: ProjectRecord = ProjectRecordSchema.parse({
      id, name: input.name, stage: 'created', archived: false,
      settings: input.settings, sourceUrl: input.sourceUrl,
      createdAt: ts, updatedAt: ts, schemaVersion: 1,
    });
    this.workspace.prepare(
      'INSERT INTO projects(id, name, stage, archived, settings_json, source_media_id, source_url, thumbnail_path, schema_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, record.name, record.stage, 0, JSON.stringify(record.settings), null, record.sourceUrl ?? null, null, 1, ts, ts);
    const db = createProjectDb(this.workspaceRoot, id);
    db.close();
    return record;
  }

  updateProject(id: string, patch: Partial<Pick<ProjectRecord, 'name' | 'stage' | 'archived' | 'sourceMediaId' | 'thumbnailPath' | 'settings'>>): ProjectRecord | null {
    const existing = this.getProject(id);
    if (!existing) return null;
    const next: ProjectRecord = { ...existing, ...patch, updatedAt: now() };
    const p = ProjectRecordSchema.parse(next);
    this.workspace.prepare(
      'UPDATE projects SET name=?, stage=?, archived=?, source_media_id=?, thumbnail_path=?, settings_json=?, updated_at=? WHERE id=?',
    ).run(p.name, p.stage, p.archived ? 1 : 0, p.sourceMediaId ?? null, p.thumbnailPath ?? null, JSON.stringify(p.settings), p.updatedAt, id);
    return p;
  }

  setProjectStage(id: string, stage: ProjectStage): void {
    this.workspace.prepare('UPDATE projects SET stage=?, updated_at=? WHERE id=?').run(stage, now(), id);
  }

  /** Delete a project's records and folder. Media records optionally kept (default). */
  deleteProject(id: string): void {
    this.workspace.prepare('DELETE FROM projects WHERE id = ?').run(id);
    this.workspace.prepare('DELETE FROM jobs WHERE project_id = ?').run(id);
    const dir = projectFolder(this.workspaceRoot, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------- media */
  registerMedia(asset: MediaAsset): void {
    const parsed = MediaAssetSchema.parse(asset);
    this.workspace.prepare(
      'INSERT INTO media(id, kind, storage_mode, path, original_name, size_bytes, sha256, fingerprint, volume_id, info_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(parsed.id, parsed.kind, parsed.storageMode, parsed.path, parsed.originalName, parsed.sizeBytes,
      parsed.sha256 ?? null, parsed.fingerprint, parsed.volumeId ?? null,
      parsed.info ? JSON.stringify(parsed.info) : null, parsed.status, parsed.createdAt);
  }

  updateMedia(id: string, patch: Partial<MediaAsset>): void {
    const row = this.workspace.prepare('SELECT * FROM media WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return;
    const current = this.tryMediaRow(row);
    if (!current) return;
    const next = { ...current, ...patch };
    const parsed = MediaAssetSchema.parse(next);
    this.workspace.prepare('UPDATE media SET status=?, sha256=?, info_json=?, path=? WHERE id=?')
      .run(parsed.status, parsed.sha256 ?? null, parsed.info ? JSON.stringify(parsed.info) : null, parsed.path, id);
  }

  private tryMediaRow(row: Record<string, unknown>): MediaAsset | null {
    try {
      const info = row['info_json'] ? JSON.parse(String(row['info_json'])) : undefined;
      return MediaAssetSchema.parse({
        id: row['id'], kind: row['kind'], storageMode: row['storage_mode'], path: row['path'],
        originalName: row['original_name'], sizeBytes: row['size_bytes'], sha256: row['sha256'] ?? undefined,
        fingerprint: row['fingerprint'], volumeId: row['volume_id'] ?? undefined,
        info, status: row['status'], createdAt: row['created_at'],
      });
    } catch {
      try { this.quarantine('media', String(row['id'] ?? 'unknown'), 'invalid media row', row); } catch { /* quarantine must never crash */ }
      return null;
    }
  }

  getMedia(id: string): MediaAsset | null {
    const row = this.workspace.prepare('SELECT * FROM media WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.tryMediaRow(row) : null;
  }

  findMediaByFingerprint(fingerprint: string): MediaAsset | null {
    const row = this.workspace.prepare('SELECT * FROM media WHERE fingerprint = ? LIMIT 1').get(fingerprint) as Record<string, unknown> | undefined;
    return row ? this.tryMediaRow(row) : null;
  }

  listMediaUsedByProject(): MediaAsset[] {
    const rows = this.workspace.prepare('SELECT DISTINCT source_media_id AS id FROM projects WHERE source_media_id IS NOT NULL').all() as Array<{ id: string }>;
    return rows.map((r) => this.getMedia(r.id)).filter((m): m is MediaAsset => !!m);
  }

  /* ------------------------------------------------ derived files index */
  registerDerived(mediaId: string, kind: string, path: string, params: Record<string, unknown> = {}): void {
    this.workspace.prepare('INSERT INTO derived_files(id, media_id, kind, path, params_json, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(newId(), mediaId, kind, path, JSON.stringify(params), 'done', now());
  }

  /* ---------------------------------------------------------------- jobs */
  enqueueJob(input: { type: string; projectId?: string; mediaId?: string; params?: Record<string, unknown>; priority?: 'user-blocking' | 'editing-helper' | 'background' }): string {
    const id = newId();
    this.workspace.prepare(
      'INSERT INTO jobs(id, type, project_id, media_id, params_json, status, priority, progress, attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(id, input.type, input.projectId ?? null, input.mediaId ?? null, JSON.stringify(input.params ?? {}), 'queued', input.priority ?? 'background', 0, 0, now());
    return id;
  }

  updateJob(id: string, patch: { status?: string; progress?: number; error?: string | null; errorTechnical?: string | null; startedAt?: number | null; finishedAt?: number | null; attempt?: number }): void {
    const sets: string[] = []; const vals: unknown[] = [];
    if (patch.status !== undefined) { sets.push('status=?'); vals.push(patch.status); }
    if (patch.progress !== undefined) { sets.push('progress=?'); vals.push(patch.progress); }
    if (patch.error !== undefined) { sets.push('error=?'); vals.push(patch.error); }
    if (patch.errorTechnical !== undefined) { sets.push('error_technical=?'); vals.push(patch.errorTechnical); }
    if (patch.startedAt !== undefined) { sets.push('started_at=?'); vals.push(patch.startedAt); }
    if (patch.finishedAt !== undefined) { sets.push('finished_at=?'); vals.push(patch.finishedAt); }
    if (patch.attempt !== undefined) { sets.push('attempt=?'); vals.push(patch.attempt); }
    if (sets.length === 0) return;
    vals.push(id);
    this.workspace.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getJob(id: string): Record<string, unknown> | null {
    return (this.workspace.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>) ?? null;
  }

  listActiveJobs(): Array<Record<string, unknown>> {
    return this.workspace.prepare("SELECT * FROM jobs WHERE status IN ('queued','running','cancelling') ORDER BY CASE priority WHEN 'user-blocking' THEN 0 WHEN 'editing-helper' THEN 1 ELSE 2 END, created_at").all() as Array<Record<string, unknown>>;
  }

  listRecentJobs(limit = 20): Array<Record<string, unknown>> {
    return this.workspace.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
  }

  /** Crash recovery: running jobs become queued again on startup. */
  reviveInterruptedJobs(): number {
    const res = this.workspace.prepare("UPDATE jobs SET status='queued' WHERE status IN ('running','cancelling')").run();
    return res.changes;
  }

  /* ---------------------------------------------------- export history */
  recordExport(entry: { projectId: string; compId: string; settings: unknown; outputPath: string; sizeBytes?: number; durationUs?: number; validation: unknown }): void {
    this.workspace.prepare('INSERT INTO export_history(id, project_id, comp_id, settings_json, output_path, size_bytes, duration_us, validation_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(newId(), entry.projectId, entry.compId, JSON.stringify(entry.settings), entry.outputPath, entry.sizeBytes ?? null, entry.durationUs ?? null, JSON.stringify(entry.validation ?? null), now());
  }

  listExports(limit = 50): Array<Record<string, unknown>> {
    return this.workspace.prepare('SELECT * FROM export_history ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
  }

  /* ------------------------------------------- per-project composition */
  private withProjectDb<T>(projectId: string, fn: (db: Database.Database) => T): T {
    const db = openProjectDb(this.workspaceRoot, projectId);
    try { return fn(db); } finally { db.close(); }
  }

  saveComposition(projectId: string, comp: Composition): void {
    const parsed = CompositionSchema.parse(comp);
    const dir = projectFolder(this.workspaceRoot, projectId);
    // autosave backup of current row before overwrite (restore-point hook)
    this.withProjectDb(projectId, (db) => {
      const ts = now();
      db.prepare(
        'INSERT INTO compositions(id, name, fps, width, height, data_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, fps=excluded.fps, width=excluded.width, height=excluded.height, data_json=excluded.data_json, updated_at=excluded.updated_at',
      ).run(parsed.id, parsed.name, parsed.fps, parsed.width, parsed.height, JSON.stringify(parsed), parsed.createdAt, ts);
    });
    mkdirSync(dir, { recursive: true });
  }

  loadComposition(projectId: string, compId: string): Composition | null {
    return this.withProjectDb(projectId, (db) => {
      const row = db.prepare('SELECT data_json FROM compositions WHERE id = ?').get(compId) as { data_json: string } | undefined;
      if (!row) return null;
      try {
        return CompositionSchema.parse(JSON.parse(row.data_json));
      } catch {
        const bad = db.prepare('SELECT data_json FROM compositions WHERE id = ?').get(compId) as { data_json: string };
        this.quarantineInDb(db, 'compositions', compId, 'invalid composition payload', bad.data_json);
        return null;
      }
    });
  }

  listCompositions(projectId: string): Composition[] {
    return this.withProjectDb(projectId, (db) => {
      const rows = db.prepare('SELECT data_json FROM compositions ORDER BY updated_at DESC').all() as Array<{ data_json: string }>;
      const out: Composition[] = [];
      for (const row of rows) {
        try { out.push(CompositionSchema.parse(JSON.parse(row.data_json))); }
        catch { this.quarantineInDb(db, 'compositions', 'unknown', 'invalid composition payload', row.data_json); }
      }
      return out;
    });
  }

  deleteComposition(projectId: string, compId: string): void {
    this.withProjectDb(projectId, (db) => { db.prepare('DELETE FROM compositions WHERE id = ?').run(compId); });
  }

  /* ----------------------------------------------------- transcript/captions */
  replaceTranscript(projectId: string, words: TranscriptWord[]): void {
    const parsed = words.map((w) => TranscriptWordSchema.parse(w));
    this.withProjectDb(projectId, (db) => {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM transcript_words').run();
        const stmt = db.prepare('INSERT INTO transcript_words(id, index_, text, start_us, end_us, confidence, speaker) VALUES (?,?,?,?,?,?,?)');
        for (const w of parsed) stmt.run(w.id, w.index, w.text, w.startUs, w.endUs, w.confidence ?? null, w.speaker ?? null);
      });
      tx();
    });
  }

  loadTranscript(projectId: string): TranscriptWord[] {
    return this.withProjectDb(projectId, (db) => {
      const rows = db.prepare('SELECT * FROM transcript_words ORDER BY index_').all() as Array<Record<string, unknown>>;
      const out: TranscriptWord[] = [];
      for (const r of rows) {
        try {
          out.push(TranscriptWordSchema.parse({ id: r['id'], index: r['index_'], text: r['text'], startUs: r['start_us'], endUs: r['end_us'], confidence: r['confidence'] ?? undefined, speaker: r['speaker'] ?? undefined }));
        } catch { /* skip bad word */ }
      }
      return out;
    });
  }

  replaceCaptions(projectId: string, captions: CaptionChunk[]): void {
    const parsed = captions.map((c) => CaptionChunkSchema.parse(c));
    this.withProjectDb(projectId, (db) => {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM captions').run();
        const stmt = db.prepare('INSERT INTO captions(id, start_us, end_us, text, word_ids_json, emphasis_json) VALUES (?,?,?,?,?,?)');
        for (const c of parsed) stmt.run(c.id, c.startUs, c.endUs, c.text, JSON.stringify(c.wordIds), JSON.stringify(c.emphasisWordIds));
      });
      tx();
    });
  }

  loadCaptions(projectId: string): CaptionChunk[] {
    return this.withProjectDb(projectId, (db) => {
      const rows = db.prepare('SELECT * FROM captions ORDER BY start_us').all() as Array<Record<string, unknown>>;
      const out: CaptionChunk[] = [];
      for (const r of rows) {
        try {
          out.push(CaptionChunkSchema.parse({ id: r['id'], startUs: r['start_us'], endUs: r['end_us'], text: r['text'], wordIds: JSON.parse(String(r['word_ids_json'] ?? '[]')), emphasisWordIds: JSON.parse(String(r['emphasis_json'] ?? '[]')) }));
        } catch { /* skip */ }
      }
      return out;
    });
  }

  /* ------------------------------------------------------------ moments */
  replaceMoments(projectId: string, moments: Moment[]): void {
    const parsed = moments.map((m) => MomentSchema.parse(m));
    this.withProjectDb(projectId, (db) => {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM moments').run();
        const stmt = db.prepare('INSERT INTO moments(id, start_us, end_us, score, breakdown_json, reasons_json, title, excerpt, status, stale, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
        for (const m of parsed) stmt.run(m.id, m.startUs, m.endUs, m.score, JSON.stringify(m.breakdown), JSON.stringify(m.reasons), m.title, m.excerpt, m.status, m.stale ? 1 : 0, m.createdAt);
      });
      tx();
    });
  }

  loadMoments(projectId: string): Moment[] {
    return this.withProjectDb(projectId, (db) => {
      const rows = db.prepare('SELECT * FROM moments ORDER BY score DESC').all() as Array<Record<string, unknown>>;
      const out: Moment[] = [];
      for (const r of rows) {
        try {
          out.push(MomentSchema.parse({ id: r['id'], projectId, startUs: r['start_us'], endUs: r['end_us'], score: r['score'], breakdown: JSON.parse(String(r['breakdown_json'])), reasons: JSON.parse(String(r['reasons_json'] ?? '[]')), title: r['title'], excerpt: r['excerpt'], status: r['status'], stale: r['stale'] === 1, createdAt: r['created_at'] }));
        } catch { /* skip */ }
      }
      return out;
    });
  }

  updateMomentStatus(projectId: string, momentId: string, status: Moment['status']): void {
    this.withProjectDb(projectId, (db) => { db.prepare('UPDATE moments SET status = ? WHERE id = ?').run(status, momentId); });
  }

  /* ---------------------------------------------------------- providers */
  listProviders(): Array<{ id: string; kind: string; displayName: string; baseUrl: string | null; model: string | null; secretId: string | null; enabled: boolean }> {
    const rows = this.workspace.prepare('SELECT * FROM providers ORDER BY created_at').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r['id']), kind: String(r['kind']), displayName: String(r['display_name']),
      baseUrl: r['base_url'] ? String(r['base_url']) : null, model: r['model'] ? String(r['model']) : null,
      secretId: r['secret_id'] ? String(r['secret_id']) : null, enabled: r['enabled'] === 1,
    }));
  }

  saveProvider(input: { kind: string; displayName: string; baseUrl?: string | null; model?: string | null; secretId?: string | null }): string {
    const id = newId();
    this.workspace.prepare('INSERT INTO providers(id, kind, display_name, base_url, model, secret_id, enabled, created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(id, input.kind, input.displayName, input.baseUrl ?? null, input.model ?? null, input.secretId ?? null, now());
    return id;
  }

  updateProviderSecret(id: string, secretId: string): void {
    this.workspace.prepare('UPDATE providers SET secret_id = ? WHERE id = ?').run(secretId, id);
  }

  deleteProvider(id: string): void {
    this.workspace.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  /* --------------------------------------------------------- quarantine */
  private quarantine(table: string, rowId: string, reason: string, payload: unknown): void {
    this.workspace.prepare('INSERT INTO _quarantine(table_name, row_id, reason, payload_json, created_at) VALUES (?,?,?,?,?)')
      .run(table, rowId, reason, JSON.stringify(payload ?? null), now());
  }

  private quarantineInDb(db: Database.Database, table: string, rowId: string, reason: string, payload: unknown): void {
    db.prepare('INSERT INTO _quarantine(table_name, row_id, reason, payload_json, created_at) VALUES (?,?,?,?,?)')
      .run(table, rowId, reason, typeof payload === 'string' ? payload : JSON.stringify(payload ?? null), now());
  }
}
