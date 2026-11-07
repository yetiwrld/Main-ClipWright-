import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {
  openDatabase,
  SqliteDatabase,
  runMigrations,
  WORKSPACE_MIGRATIONS,
  PROJECT_MIGRATIONS,
  readValidatedRows,
  CURRENT_SCHEMA_VERSION,
  ProjectRecord,
  ProjectRecordSchema,
  CompositionRecord,
  CompositionRecordSchema,
  CompositionPayload,
  MediaRecord,
  MediaRecordSchema,
  Transcript,
  TranscriptSchema,
  Word,
  WordSchema,
  Moment,
  MomentSchema,
  JobRecord,
  JobRecordSchema,
  ProviderRecord,
  ProviderRecordSchema,
  AppSettings,
  AppSettingsSchema,
  JournalEntry,
  JournalEntrySchema,
  CwpackManifest,
  CwpackManifestSchema,
  uuidv7,
} from '@clipwright/project-schema';
import { Logger } from './logger.js';

export const WORKSPACE_FOLDERS = [
  'Projects',
  'Media',
  'Proxies',
  'Clips',
  'Exports',
  'Cache',
  'Cache/downloads',
  'Cache/features',
  'Cache/frames',
  'Cache/waveforms',
  'Models',
  'Models/whisper',
  'Models/onnx',
  'Recovery',
  'Logs',
  'Logs/crash',
  'CaptionStyles',
  'Templates',
  'BrandKits',
  'Fonts',
  'Backups',
  'Updates',
] as const;

export interface ConsentRecord {
  id: string;
  providerId: string;
  /** What may be sent: 'transcript' | 'audio' | 'test_payload'. */
  category: string;
  /** 'once' survives for a single task; 'always' persists. */
  scope: string;
  grantedAt: string;
}

export interface DataSentEntry {
  ts: string;
  providerHost: string;
  task: string;
  category: string;
  approxBytes: number;
}

export interface RecoveryCheckResult {
  needsRecovery: boolean;
  lockedByLiveProcess: boolean;
  journalCount: number;
  corruptCount: number;
  lastEntryTs?: string;
}

export interface RestorePointRecord {
  id: string;
  label?: string;
  named: boolean;
  createdAt: string;
  sizeBytes: number;
  filePath: string;
}

export class StorageService {
  private workspaceDir: string;
  private appDataDir: string;
  private workspaceDb!: SqliteDatabase;
  private projectDbs = new Map<string, SqliteDatabase>();
  private projectReadOnly = new Map<string, { readOnly: boolean; reason?: string }>();
  public readonly logger: Logger;

  constructor(workspaceDir: string, appDataDir?: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.appDataDir = appDataDir
      ? path.resolve(appDataDir)
      : path.join(os.homedir(), '.config', 'Clipwright Studio');
    this.initWorkspaceFolders(this.workspaceDir);
    this.logger = new Logger(path.join(this.workspaceDir, 'Logs'));
    this.openWorkspaceDatabase();
  }

  public getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  public getAppDataDir(): string {
    return this.appDataDir;
  }

  public initWorkspaceFolders(rootDir: string): void {
    fs.mkdirSync(rootDir, { recursive: true });
    for (const sub of WORKSPACE_FOLDERS) {
      fs.mkdirSync(path.join(rootDir, sub), { recursive: true });
    }

    const proxiesReadme = path.join(rootDir, 'Proxies', 'README.txt');
    if (!fs.existsSync(proxiesReadme)) {
      fs.writeFileSync(
        proxiesReadme,
        'Reserved for forward compatibility. Per-media proxies live alongside their source media in Media/<mediaId>/ so deleting a media folder never leaves orphan proxies.\n',
        'utf8'
      );
    }

    const rootReadme = path.join(rootDir, 'README.txt');
    if (!fs.existsSync(rootReadme)) {
      fs.writeFileSync(
        rootReadme,
        'Clipwright Studio Workspace Folder\n\n' +
          '- Projects/: Per-project databases and thumbnails\n' +
          '- Media/: Managed media copies, proxies, waveforms and thumbnails\n' +
          '- Exports/: Finished exported video files\n' +
          '- Models/: Downloaded local Whisper and ONNX models\n' +
          '- Recovery/: Crash recovery journals and restore points\n' +
          '- Cache/: Safe-to-delete temporary caches\n',
        'utf8'
      );
    }

    const wsJson = path.join(rootDir, 'workspace.json');
    if (!fs.existsSync(wsJson)) {
      fs.writeFileSync(
        wsJson,
        JSON.stringify(
          {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            createdAt: new Date().toISOString(),
            appVersion: '1.0.0',
            workspaceId: uuidv7(),
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
    }

    fs.mkdirSync(this.appDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.appDataDir, 'app-state.json'),
      JSON.stringify({ workspacePath: rootDir, updatedAt: new Date().toISOString() }, null, 2) +
        '\n',
      'utf8'
    );
  }

  private openWorkspaceDatabase(): void {
    const dbPath = path.join(this.workspaceDir, 'workspace.db');
    this.workspaceDb = openDatabase(dbPath);
    runMigrations(this.workspaceDb, WORKSPACE_MIGRATIONS, {
      isProjectDb: false,
      backupDir: path.join(this.workspaceDir, 'Backups', 'workspace'),
    });
  }

  public getProjectDir(projectId: string): string {
    return path.join(this.workspaceDir, 'Projects', projectId);
  }

  public getRecoveryDir(projectId: string): string {
    return path.join(this.workspaceDir, 'Recovery', projectId);
  }

  public openProjectDb(projectId: string): {
    db: SqliteDatabase;
    readOnly: boolean;
    readOnlyReason?: string;
  } {
    if (this.projectDbs.has(projectId)) {
      const db = this.projectDbs.get(projectId)!;
      const ro = this.projectReadOnly.get(projectId) ?? { readOnly: false };
      return { db, readOnly: ro.readOnly, readOnlyReason: ro.reason };
    }

    const projDir = this.getProjectDir(projectId);
    fs.mkdirSync(projDir, { recursive: true });
    const dbPath = path.join(projDir, 'project.cwdb');
    let db = openDatabase(dbPath);
    const migRes = runMigrations(db, PROJECT_MIGRATIONS, {
      isProjectDb: true,
      backupDir: path.join(this.workspaceDir, 'Backups', projectId),
    });

    if (migRes.restoredFromBackup) {
      db = openDatabase(dbPath);
    }

    this.projectDbs.set(projectId, db);
    this.projectReadOnly.set(projectId, {
      readOnly: migRes.readOnly,
      reason: migRes.readOnlyReason,
    });
    return { db, readOnly: migRes.readOnly, readOnlyReason: migRes.readOnlyReason };
  }

  public closeProjectDb(projectId: string): void {
    const db = this.projectDbs.get(projectId);
    if (db) {
      db.close();
      this.projectDbs.delete(projectId);
      this.projectReadOnly.delete(projectId);
    }
  }

  public closeAll(): void {
    for (const [id] of this.projectDbs) {
      this.closeProjectDb(id);
    }
    this.workspaceDb.close();
  }

  /* ==========================================================================
   * SETTINGS (Spec 03 §11)
   * ======================================================================== */
  public getSettings(): AppSettings {
    const row = this.workspaceDb
      .prepare("SELECT value_json FROM settings WHERE key = 'app'")
      .get<{ value_json: string }>();
    if (!row) {
      return AppSettingsSchema.parse({ workspacePath: this.workspaceDir });
    }
    try {
      const parsed = JSON.parse(row.value_json);
      return AppSettingsSchema.parse({ ...parsed, workspacePath: this.workspaceDir });
    } catch (err: any) {
      this.logger.warn('AppSettings validation failed; returning default', { error: err?.message });
      return AppSettingsSchema.parse({ workspacePath: this.workspaceDir });
    }
  }

  public updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const merged = AppSettingsSchema.parse({
      ...current,
      ...patch,
      workspacePath: this.workspaceDir,
    });
    this.workspaceDb
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES ('app', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(merged), new Date().toISOString());
    return merged;
  }

  public resetSettings(): AppSettings {
    const defaults = AppSettingsSchema.parse({
      firstRunCompleted: true,
      workspacePath: this.workspaceDir,
    });
    this.workspaceDb
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES ('app', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(defaults), new Date().toISOString());
    return defaults;
  }

  /* ==========================================================================
   * PROJECTS CRUD (Spec 03 §4 & §10)
   * ======================================================================== */
  public createProject(params: {
    name: string;
    sourceMediaIds?: string[];
    settings?: Partial<ProjectRecord['settings']>;
    id?: string;
  }): ProjectRecord {
    const now = new Date().toISOString();
    const id = params.id ?? uuidv7();
    const record = ProjectRecordSchema.parse({
      id,
      name: params.name,
      createdAt: now,
      updatedAt: now,
      archived: false,
      stage: 'import',
      sourceMediaIds: params.sourceMediaIds ?? [],
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appVersionLastSaved: '1.0.0',
      settings: params.settings ?? {},
    });

    const tx = this.workspaceDb.transaction(() => {
      this.workspaceDb
        .prepare(
          `INSERT INTO projects (id, name, stage, archived, created_at, updated_at, payload_json)
           VALUES (?, ?, ?, 0, ?, ?, ?)`
        )
        .run(record.id, record.name, record.stage, record.createdAt, record.updatedAt, JSON.stringify(record));
    });
    tx();

    const { db } = this.openProjectDb(record.id);
    db.prepare(
      `INSERT INTO meta (key, value_json) VALUES ('project', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
    ).run(JSON.stringify(record));

    fs.mkdirSync(this.getRecoveryDir(record.id), { recursive: true });
    fs.mkdirSync(path.join(this.getRecoveryDir(record.id), 'checkpoints'), { recursive: true });

    return record;
  }

  public getProject(projectId: string): ProjectRecord | undefined {
    const res = readValidatedRows(
      this.workspaceDb,
      'projects',
      'id',
      'payload_json',
      ProjectRecordSchema,
      `WHERE id = '${projectId.replace(/'/g, "''")}'`
    );
    return res.items[0];
  }

  public listProjects(includeArchived = false): {
    projects: ProjectRecord[];
    recoveredWithProblems: boolean;
  } {
    const res = readValidatedRows(
      this.workspaceDb,
      'projects',
      'id',
      'payload_json',
      ProjectRecordSchema
    );
    const filtered = includeArchived ? res.items : res.items.filter((p) => !p.archived);
    filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { projects: filtered, recoveredWithProblems: res.recoveredWithProblems };
  }

  public updateProject(projectId: string, patch: Partial<ProjectRecord>): ProjectRecord {
    const existing = this.getProject(projectId);
    if (!existing) throw new Error(`Project ${projectId} not found`);
    const updated = ProjectRecordSchema.parse({
      ...existing,
      ...patch,
      id: projectId,
      updatedAt: new Date().toISOString(),
    });

    this.workspaceDb
      .prepare(
        `UPDATE projects SET name = ?, stage = ?, archived = ?, updated_at = ?, payload_json = ? WHERE id = ?`
      )
      .run(
        updated.name,
        updated.stage,
        updated.archived ? 1 : 0,
        updated.updatedAt,
        JSON.stringify(updated),
        projectId
      );

    const { db, readOnly } = this.openProjectDb(projectId);
    if (!readOnly) {
      db.prepare(
        `INSERT INTO meta (key, value_json) VALUES ('project', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      ).run(JSON.stringify(updated));
    }
    return updated;
  }

  public duplicateProject(projectId: string): ProjectRecord {
    const src = this.getProject(projectId);
    if (!src) throw new Error(`Project ${projectId} not found`);
    const newId = uuidv7();
    const copyName = `${src.name} copy`;

    const { db: srcDb } = this.openProjectDb(projectId);
    const newProjDir = this.getProjectDir(newId);
    fs.mkdirSync(newProjDir, { recursive: true });
    srcDb.backupTo(path.join(newProjDir, 'project.cwdb'));

    const now = new Date().toISOString();
    const duplicated = ProjectRecordSchema.parse({
      ...src,
      id: newId,
      name: copyName,
      createdAt: now,
      updatedAt: now,
    });

    this.workspaceDb
      .prepare(
        `INSERT INTO projects (id, name, stage, archived, created_at, updated_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        duplicated.id,
        duplicated.name,
        duplicated.stage,
        duplicated.archived ? 1 : 0,
        duplicated.createdAt,
        duplicated.updatedAt,
        JSON.stringify(duplicated)
      );

    const { db: destDb } = this.openProjectDb(newId);
    destDb
      .prepare(
        `INSERT INTO meta (key, value_json) VALUES ('project', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(JSON.stringify(duplicated));

    return duplicated;
  }

  public deleteProject(
    projectId: string,
    opts?: { deleteExclusiveManagedMedia?: boolean }
  ): { deletedProjectId: string; deletedMediaIds: string[] } {
    const proj = this.getProject(projectId);
    if (!proj) return { deletedProjectId: projectId, deletedMediaIds: [] };

    const deletedMediaIds: string[] = [];
    if (opts?.deleteExclusiveManagedMedia) {
      const otherProjects = this.listProjects(true).projects.filter((p) => p.id !== projectId);
      const otherMediaIds = new Set(otherProjects.flatMap((p) => p.sourceMediaIds));
      for (const mediaId of proj.sourceMediaIds) {
        if (!otherMediaIds.has(mediaId)) {
          const media = this.getMedia(mediaId);
          if (media && media.storageMode === 'managed') {
            const mediaFolder = path.join(this.workspaceDir, 'Media', mediaId);
            if (fs.existsSync(mediaFolder)) {
              fs.rmSync(mediaFolder, { recursive: true, force: true });
            }
            this.workspaceDb.prepare('DELETE FROM media WHERE id = ?').run(mediaId);
            this.workspaceDb.prepare('DELETE FROM derived_files WHERE media_id = ?').run(mediaId);
            deletedMediaIds.push(mediaId);
          }
        }
      }
    }

    this.closeProjectDb(projectId);
    this.workspaceDb.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    const projDir = this.getProjectDir(projectId);
    if (fs.existsSync(projDir)) {
      fs.rmSync(projDir, { recursive: true, force: true });
    }
    const recDir = this.getRecoveryDir(projectId);
    if (fs.existsSync(recDir)) {
      fs.rmSync(recDir, { recursive: true, force: true });
    }

    return { deletedProjectId: projectId, deletedMediaIds };
  }

  /* ==========================================================================
   * COMPOSITIONS, JOURNAL & CHECKPOINTS (Spec 03 §5)
   * ======================================================================== */
  public saveComposition(projectId: string, comp: CompositionRecord): CompositionRecord {
    const validated = CompositionRecordSchema.parse(comp);
    const { db, readOnly, readOnlyReason } = this.openProjectDb(projectId);
    if (readOnly) {
      throw new Error(readOnlyReason || 'Project is read-only');
    }

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO compositions (id, project_id, name, version, updated_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           updated_at = excluded.updated_at,
           payload_json = excluded.payload_json`
      ).run(
        validated.id,
        validated.projectId,
        validated.name,
        validated.version,
        validated.updatedAt,
        JSON.stringify(validated)
      );

      // Sync items_index (Spec 03 §4)
      db.prepare('DELETE FROM items_index WHERE comp_id = ?').run(validated.id);
      const insertIdx = db.prepare(
        `INSERT INTO items_index (comp_id, item_id, track_id, start_us, end_us, media_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const item of Object.values(validated.payload.items)) {
        insertIdx.run(
          validated.id,
          item.id,
          item.trackId,
          item.startUs,
          item.startUs + item.durationUs,
          item.mediaId ?? null
        );
      }
    });
    tx();
    return validated;
  }

  public listCompositions(projectId: string): {
    compositions: CompositionRecord[];
    recoveredWithProblems: boolean;
  } {
    const { db } = this.openProjectDb(projectId);
    const res = readValidatedRows(
      db,
      'compositions',
      'id',
      'payload_json',
      CompositionRecordSchema
    );
    return {
      compositions: res.items,
      recoveredWithProblems: res.recoveredWithProblems,
    };
  }

  public getComposition(projectId: string, compId: string): CompositionRecord | undefined {
    const { db } = this.openProjectDb(projectId);
    const res = readValidatedRows(
      db,
      'compositions',
      'id',
      'payload_json',
      CompositionRecordSchema,
      `WHERE id = '${compId.replace(/'/g, "''")}'`
    );
    return res.items[0];
  }

  public getJournalPath(projectId: string): string {
    const recDir = this.getRecoveryDir(projectId);
    fs.mkdirSync(recDir, { recursive: true });
    return path.join(recDir, 'journal.jsonl');
  }

  public appendJournalEntry(projectId: string, entry: JournalEntry, fsyncImmediate = true): void {
    const validated = JournalEntrySchema.parse(entry);
    const journalPath = this.getJournalPath(projectId);
    const fd = fs.openSync(journalPath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(validated) + '\n', undefined, 'utf8');
      if (fsyncImmediate) {
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  public writeCheckpoint(
    projectId: string,
    compositions: CompositionRecord[],
    upToSeq?: number
  ): void {
    const { db, readOnly, readOnlyReason } = this.openProjectDb(projectId);
    if (readOnly) {
      throw new Error(readOnlyReason || 'Project is read-only');
    }

    db.pragma('synchronous = FULL');
    try {
      const tx = db.transaction(() => {
        for (const comp of compositions) {
          this.saveComposition(projectId, comp);
        }
      });
      tx();
    } finally {
      db.pragma('synchronous = NORMAL');
    }

    // Truncate journal up to upToSeq (or completely if unspecified)
    const journalPath = this.getJournalPath(projectId);
    if (fs.existsSync(journalPath)) {
      if (upToSeq === undefined) {
        fs.writeFileSync(journalPath, '', 'utf8');
      } else {
        const lines = fs
          .readFileSync(journalPath, 'utf8')
          .split('\n')
          .filter((l) => l.trim().length > 0);
        const remaining = lines.filter((line) => {
          try {
            const parsed = JSON.parse(line);
            return typeof parsed.seq === 'number' && parsed.seq > upToSeq;
          } catch {
            return false;
          }
        });
        fs.writeFileSync(
          journalPath,
          remaining.length > 0 ? remaining.join('\n') + '\n' : '',
          'utf8'
        );
      }
    }
  }

  /* ==========================================================================
   * LOCK FILES & CRASH RECOVERY (Spec 03 §6)
   * ======================================================================== */
  public acquireProjectLock(
    projectId: string,
    pid = process.pid
  ): { acquired: boolean; staleLockRecovered: boolean; ownerPid?: number } {
    const lockPath = path.join(this.getProjectDir(projectId), 'lock.json');
    let staleLockRecovered = false;

    if (fs.existsSync(lockPath)) {
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const heartbeatAgeMs = Date.now() - new Date(lock.heartbeatAt || lock.startedAt).getTime();
        let pidAlive = false;
        if (lock.pid && lock.pid !== pid) {
          try {
            process.kill(lock.pid, 0);
            pidAlive = true;
          } catch {
            pidAlive = false;
          }
        }
        if (pidAlive && heartbeatAgeMs < 15000) {
          return { acquired: false, staleLockRecovered: false, ownerPid: lock.pid };
        }
        staleLockRecovered = true;
      } catch {
        staleLockRecovered = true;
      }
    }

    const now = new Date().toISOString();
    fs.writeFileSync(
      lockPath,
      JSON.stringify(
        {
          pid,
          startedAt: now,
          heartbeatAt: now,
          hostname: os.hostname(),
          appVersion: '1.0.0',
        },
        null,
        2
      ),
      'utf8'
    );
    return { acquired: true, staleLockRecovered };
  }

  public refreshProjectLock(projectId: string): void {
    const lockPath = path.join(this.getProjectDir(projectId), 'lock.json');
    if (!fs.existsSync(lockPath)) return;
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      lock.heartbeatAt = new Date().toISOString();
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }

  public releaseProjectLock(projectId: string): void {
    const lockPath = path.join(this.getProjectDir(projectId), 'lock.json');
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  }

  public checkProjectRecovery(projectId: string): {
    entries: JournalEntry[];
    corruptLines: string[];
    needsRecovery: boolean;
  } {
    const journalPath = this.getJournalPath(projectId);
    if (!fs.existsSync(journalPath)) {
      return { entries: [], corruptLines: [], needsRecovery: false };
    }
    const raw = fs.readFileSync(journalPath, 'utf8').trim();
    if (!raw) {
      return { entries: [], corruptLines: [], needsRecovery: false };
    }

    const lines = raw.split('\n');
    const entries: JournalEntry[] = [];
    const corruptLines: string[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        entries.push(JournalEntrySchema.parse(parsed));
      } catch {
        corruptLines.push(line);
      }
    }

    if (corruptLines.length > 0) {
      const corruptDir = path.join(this.getRecoveryDir(projectId), 'corrupt');
      fs.mkdirSync(corruptDir, { recursive: true });
      fs.writeFileSync(
        path.join(corruptDir, `corrupt-${Date.now()}.jsonl`),
        corruptLines.join('\n') + '\n',
        'utf8'
      );
    }

    return {
      entries,
      corruptLines,
      needsRecovery: entries.length > 0 || corruptLines.length > 0,
    };
  }

  public replayRecoveryJournal(projectId: string): {
    recoveredCompositions: CompositionRecord[];
    appliedCount: number;
    corruptCount: number;
  } {
    const check = this.checkProjectRecovery(projectId);
    if (check.entries.length === 0) {
      return {
        recoveredCompositions: this.listCompositions(projectId).compositions,
        appliedCount: 0,
        corruptCount: check.corruptLines.length,
      };
    }

    // Save a named restore point "Before recovery" first (Spec 03 §6.3)
    this.createRestorePoint(projectId, 'Before recovery', true);

    const compsMap = new Map<string, CompositionRecord>();
    for (const c of this.listCompositions(projectId).compositions) {
      compsMap.set(c.id, c);
    }

    let appliedCount = 0;
    for (const entry of check.entries.sort((a, b) => a.seq - b.seq)) {
      const target = compsMap.get(entry.compId);
      const patch = entry.forwardPatch as Partial<CompositionPayload> | undefined;
      if (target && patch && typeof patch === 'object') {
        const nextPayload = {
          ...target.payload,
          ...patch,
        };
        const updatedComp = CompositionRecordSchema.parse({
          ...target,
          version: target.version + 1,
          updatedAt: entry.ts,
          payload: nextPayload,
        });
        compsMap.set(entry.compId, updatedComp);
        appliedCount++;
      }
    }

    const updatedList = Array.from(compsMap.values());
    this.writeCheckpoint(projectId, updatedList);
    return {
      recoveredCompositions: updatedList,
      appliedCount,
      corruptCount: check.corruptLines.length,
    };
  }

  /* ==========================================================================
   * RESTORE POINTS / VERSION HISTORY (Spec 03 §7)
   * ======================================================================== */
  public createRestorePoint(
    projectId: string,
    label?: string,
    named = false
  ): RestorePointRecord {
    const { db } = this.openProjectDb(projectId);
    const comps = this.listCompositions(projectId).compositions;
    const transcript = this.getTranscript(projectId);
    const moments = this.listMoments(projectId);

    const snapshot = {
      projectId,
      createdAt: new Date().toISOString(),
      label,
      named,
      compositions: comps,
      transcript,
      moments,
    };

    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
    const cpDir = path.join(this.getRecoveryDir(projectId), 'checkpoints');
    fs.mkdirSync(cpDir, { recursive: true });
    const id = uuidv7();
    const filePath = path.join(cpDir, `${Date.now()}-${id}.cwcp`);
    fs.writeFileSync(filePath, compressed);

    const record: RestorePointRecord = {
      id,
      label,
      named,
      createdAt: snapshot.createdAt,
      sizeBytes: compressed.byteLength,
      filePath,
    };

    db.prepare(
      `INSERT INTO history_checkpoints (id, label, named, created_at, size_bytes, file_path)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.label ?? null,
      record.named ? 1 : 0,
      record.createdAt,
      record.sizeBytes,
      record.filePath
    );

    this.pruneRestorePoints(projectId);
    return record;
  }

  public listRestorePoints(projectId: string): RestorePointRecord[] {
    const { db } = this.openProjectDb(projectId);
    const rows = db
      .prepare('SELECT * FROM history_checkpoints ORDER BY created_at DESC')
      .all<{
        id: string;
        label: string | null;
        named: number;
        created_at: string;
        size_bytes: number;
        file_path: string;
      }>();
    return rows.map((r) => ({
      id: r.id,
      label: r.label ?? undefined,
      named: Boolean(r.named),
      createdAt: r.created_at,
      sizeBytes: r.size_bytes,
      filePath: r.file_path,
    }));
  }

  public pruneRestorePoints(projectId: string, keepRecent = 20): void {
    const { db } = this.openProjectDb(projectId);
    const all = this.listRestorePoints(projectId);
    if (all.length <= 1) return;

    const keepIds = new Set<string>();
    // Always keep most recent restore point & named versions (Spec 03 §7)
    keepIds.add(all[0].id);
    for (const pt of all) {
      if (pt.named) keepIds.add(pt.id);
    }

    const unnamed = all.filter((p) => !p.named);
    for (const pt of unnamed.slice(0, keepRecent)) {
      keepIds.add(pt.id);
    }

    // Also keep one per day for 14 days
    const seenDays = new Set<string>();
    const cutoffMs = Date.now() - 14 * 24 * 3600 * 1000;
    for (const pt of unnamed) {
      const ts = new Date(pt.createdAt).getTime();
      if (ts >= cutoffMs) {
        const day = pt.createdAt.slice(0, 10);
        if (!seenDays.has(day)) {
          seenDays.add(day);
          keepIds.add(pt.id);
        }
      }
    }

    for (const pt of all) {
      if (!keepIds.has(pt.id)) {
        if (fs.existsSync(pt.filePath)) {
          try {
            fs.unlinkSync(pt.filePath);
          } catch {
            // ignore
          }
        }
        db.prepare('DELETE FROM history_checkpoints WHERE id = ?').run(pt.id);
      }
    }
  }

  public restoreFromPoint(
    projectId: string,
    pointId: string,
    onlyCompId?: string
  ): CompositionRecord[] {
    const all = this.listRestorePoints(projectId);
    const target = all.find((p) => p.id === pointId);
    if (!target || !fs.existsSync(target.filePath)) {
      throw new Error(`Restore point ${pointId} not found`);
    }

    // Create pre-restore point of current state (Spec 03 §7)
    this.createRestorePoint(projectId, 'Before restore', true);

    const decompressed = zlib.gunzipSync(fs.readFileSync(target.filePath)).toString('utf8');
    const snapshot = JSON.parse(decompressed) as {
      compositions: CompositionRecord[];
    };

    const toRestore = onlyCompId
      ? snapshot.compositions.filter((c) => c.id === onlyCompId)
      : snapshot.compositions;

    for (const comp of toRestore) {
      this.saveComposition(projectId, comp);
    }
    return this.listCompositions(projectId).compositions;
  }

  /* ==========================================================================
   * MEDIA, TRANSCRIPT, MOMENTS, JOBS & PROVIDERS
   * ======================================================================== */
  public saveMedia(media: MediaRecord): MediaRecord {
    const validated = MediaRecordSchema.parse(media);
    this.workspaceDb
      .prepare(
        `INSERT INTO media (id, kind, storage_mode, path, original_name, size_bytes, sha256, fingerprint, status, created_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path,
           status = excluded.status,
           sha256 = excluded.sha256,
           payload_json = excluded.payload_json`
      )
      .run(
        validated.id,
        validated.kind,
        validated.storageMode,
        validated.path,
        validated.originalName,
        validated.sizeBytes,
        validated.sha256 ?? null,
        validated.fingerprint,
        validated.status,
        validated.createdAt,
        JSON.stringify(validated)
      );
    return validated;
  }

  public getMedia(mediaId: string): MediaRecord | undefined {
    const res = readValidatedRows(
      this.workspaceDb,
      'media',
      'id',
      'payload_json',
      MediaRecordSchema,
      `WHERE id = '${mediaId.replace(/'/g, "''")}'`
    );
    return res.items[0];
  }

  public listMedia(): MediaRecord[] {
    return readValidatedRows(this.workspaceDb, 'media', 'id', 'payload_json', MediaRecordSchema)
      .items;
  }

  public findMediaBySha256OrFingerprint(hash: string): MediaRecord | undefined {
    const all = this.listMedia();
    return all.find((m) => m.sha256 === hash || m.fingerprint === hash);
  }

  public getMediaUsageCount(projectId: string, mediaId: string): number {
    const { db } = this.openProjectDb(projectId);
    const row = db
      .prepare('SELECT COUNT(*) as cnt FROM items_index WHERE media_id = ?')
      .get<{ cnt: number }>(mediaId);
    return Number(row?.cnt ?? 0);
  }

  public saveTranscript(projectId: string, transcript: Transcript): Transcript {
    const validated = TranscriptSchema.parse(transcript);
    const { db, readOnly, readOnlyReason } = this.openProjectDb(projectId);
    if (readOnly) throw new Error(readOnlyReason || 'Project is read-only');

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM transcript_words').run();
      const insertWord = db.prepare(
        `INSERT INTO transcript_words (id, start_us, end_us, chunk_index, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const w of validated.words) {
        insertWord.run(w.id, w.startUs, w.endUs, w.chunkIndex, JSON.stringify(w));
      }

      const structure = { ...validated, words: [] };
      db.prepare(
        `INSERT INTO transcript_structure (id, payload_json) VALUES ('main', ?)
         ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`
      ).run(JSON.stringify(structure));
    });
    tx();
    return validated;
  }

  public getTranscript(projectId: string): Transcript | undefined {
    const { db } = this.openProjectDb(projectId);
    const structRow = db
      .prepare("SELECT payload_json FROM transcript_structure WHERE id = 'main'")
      .get<{ payload_json: string }>();
    if (!structRow) return undefined;

    const wordRes = readValidatedRows(
      db,
      'transcript_words',
      'id',
      'payload_json',
      WordSchema,
      'ORDER BY start_us ASC'
    );
    const base = JSON.parse(structRow.payload_json);
    return TranscriptSchema.parse({
      ...base,
      words: wordRes.items,
    });
  }

  public saveMoments(projectId: string, moments: Moment[]): Moment[] {
    const { db, readOnly, readOnlyReason } = this.openProjectDb(projectId);
    if (readOnly) throw new Error(readOnlyReason || 'Project is read-only');

    const validated = moments.map((m) => MomentSchema.parse(m));
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM moments').run();
      const stmt = db.prepare(
        `INSERT INTO moments (id, score, start_us, end_us, status, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const m of validated) {
        stmt.run(m.id, m.score, m.startUs, m.endUs, m.status, JSON.stringify(m));
      }
    });
    tx();
    return validated;
  }

  public listMoments(projectId: string): Moment[] {
    const { db } = this.openProjectDb(projectId);
    return readValidatedRows(
      db,
      'moments',
      'id',
      'payload_json',
      MomentSchema,
      'ORDER BY score DESC, start_us ASC'
    ).items;
  }

  public saveJob(job: JobRecord): JobRecord {
    const validated = JobRecordSchema.parse(job);
    this.workspaceDb
      .prepare(
        `INSERT INTO jobs (id, type, project_id, media_id, status, priority, progress, attempt, error, started_at, finished_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           progress = excluded.progress,
           attempt = excluded.attempt,
           error = excluded.error,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           payload_json = excluded.payload_json`
      )
      .run(
        validated.id,
        validated.type,
        validated.projectId ?? null,
        validated.mediaId ?? null,
        validated.status,
        validated.priority,
        validated.progress,
        validated.attempt,
        validated.error ?? null,
        validated.startedAt ?? null,
        validated.finishedAt ?? null,
        JSON.stringify(validated)
      );
    return validated;
  }

  public listJobs(): JobRecord[] {
    return readValidatedRows(
      this.workspaceDb,
      'jobs',
      'id',
      'payload_json',
      JobRecordSchema,
      'ORDER BY priority ASC'
    ).items;
  }

  public saveProvider(provider: ProviderRecord): ProviderRecord {
    const validated = ProviderRecordSchema.parse(provider);
    this.workspaceDb
      .prepare(
        `INSERT INTO providers (id, name, kind, locality, status, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           locality = excluded.locality,
           status = excluded.status,
           payload_json = excluded.payload_json`
      )
      .run(
        validated.id,
        validated.name,
        validated.kind,
        validated.locality,
        validated.status,
        JSON.stringify(validated)
      );
    return validated;
  }

  public listProviders(): ProviderRecord[] {
    return readValidatedRows(
      this.workspaceDb,
      'providers',
      'id',
      'payload_json',
      ProviderRecordSchema
    ).items;
  }

  public deleteProvider(providerId: string): void {
    this.workspaceDb.prepare('DELETE FROM providers WHERE id = ?').run(providerId);
    this.workspaceDb.prepare('DELETE FROM consents WHERE provider_id = ?').run(providerId);
  }

  /* ==========================================================================
   * CONSENT AND DATA-SENT LOG (Spec 06 §8)
   *
   * Consents are not secrets: they live in workspace.db so the Privacy screen
   * can list them, and they travel with the workspace. The log records only
   * metadata — never transcript text, never audio.
   * ======================================================================== */

  public listConsents(): ConsentRecord[] {
    return this.workspaceDb
      .prepare('SELECT id, provider_id, category, scope, granted_at FROM consents ORDER BY granted_at DESC')
      .all<{ id: string; provider_id: string; category: string; scope: string; granted_at: string }>()
      .map((row) => ({
        id: row.id,
        providerId: row.provider_id,
        category: row.category,
        scope: row.scope,
        grantedAt: row.granted_at,
      }));
  }

  public saveConsent(consent: ConsentRecord): ConsentRecord {
    this.workspaceDb
      .prepare(
        `INSERT INTO consents (id, provider_id, category, scope, granted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, granted_at = excluded.granted_at`
      )
      .run(consent.id, consent.providerId, consent.category, consent.scope, consent.grantedAt);
    return consent;
  }

  public findConsent(providerId: string, category: string): ConsentRecord | undefined {
    return this.listConsents().find((c) => c.providerId === providerId && c.category === category);
  }

  public deleteConsent(id: string): void {
    this.workspaceDb.prepare('DELETE FROM consents WHERE id = ?').run(id);
  }

  public deleteConsentsForProvider(providerId: string): void {
    this.workspaceDb.prepare('DELETE FROM consents WHERE provider_id = ?').run(providerId);
  }

  public appendDataSent(entry: DataSentEntry): void {
    this.workspaceDb
      .prepare('INSERT INTO data_sent_log (ts, provider_host, task, category, approx_bytes) VALUES (?, ?, ?, ?, ?)')
      .run(entry.ts, entry.providerHost, entry.task, entry.category, Math.round(entry.approxBytes));
  }

  public listDataSent(limit = 200): DataSentEntry[] {
    return this.workspaceDb
      .prepare(
        'SELECT ts, provider_host, task, category, approx_bytes FROM data_sent_log ORDER BY id DESC LIMIT ?'
      )
      .all<{ ts: string; provider_host: string; task: string; category: string; approx_bytes: number }>(limit)
      .map((row) => ({
        ts: row.ts,
        providerHost: row.provider_host,
        task: row.task,
        category: row.category,
        approxBytes: row.approx_bytes,
      }));
  }

  public clearDataSent(): number {
    const row = this.workspaceDb.prepare('SELECT COUNT(*) AS n FROM data_sent_log').get<{ n: number }>();
    this.workspaceDb.prepare('DELETE FROM data_sent_log').run();
    return row?.n ?? 0;
  }

  /** Records a measured model throughput so later runs can show "≈ N× real time". */
  public saveModelThroughput(modelId: string, throughputFactor: number, category = 'whisper'): void {
    this.workspaceDb
      .prepare(
        `INSERT INTO models (id, category, name, status, size_bytes, throughput_factor, payload_json)
         VALUES (?, ?, ?, 'installed', 0, ?, '{}')
         ON CONFLICT(id) DO UPDATE SET throughput_factor = excluded.throughput_factor, status = 'installed'`
      )
      .run(modelId, category, modelId, throughputFactor);
  }

  public listModelThroughputs(category = 'whisper'): Record<string, number> {
    const rows = this.workspaceDb
      .prepare('SELECT id, throughput_factor FROM models WHERE category = ? AND throughput_factor IS NOT NULL')
      .all<{ id: string; throughput_factor: number }>(category);
    return Object.fromEntries(rows.map((row) => [row.id, row.throughput_factor]));
  }

  /* ==========================================================================
   * PROJECT PACKAGE (.cwpack) EXPORT & IMPORT (Spec 03 §10.3)
   * ======================================================================== */
  private sha256Buffer(buf: Buffer): string {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  private sha256File(filePath: string): string {
    return this.sha256Buffer(fs.readFileSync(filePath));
  }

  public exportProjectPackage(
    projectId: string,
    destPackPath: string,
    opts?: { includeMedia?: boolean }
  ): { packPath: string; packageSha256: string; manifest: CwpackManifest } {
    const includeMedia = opts?.includeMedia ?? true;
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const { db } = this.openProjectDb(projectId);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwpack-export-'));
    try {
      const dbCopyPath = path.join(tempDir, 'project.cwdb');
      db.backupTo(dbCopyPath);
      const dbBuf = fs.readFileSync(dbCopyPath);

      const checksums: Record<string, string> = {
        'project.cwdb': this.sha256Buffer(dbBuf),
      };

      const mediaEntries: CwpackManifest['media'] = [];
      const filesMap: Record<string, string> = {
        'project.cwdb': dbBuf.toString('base64'),
      };

      for (const mediaId of project.sourceMediaIds) {
        const m = this.getMedia(mediaId);
        if (!m) continue;
        const ext = path.extname(m.path) || '.mp4';
        const hasFile = includeMedia && fs.existsSync(m.path);
        const relKey = `media/${mediaId}/original${ext}`;
        let fileHash = m.sha256 || '';
        if (hasFile) {
          const buf = fs.readFileSync(m.path);
          fileHash = this.sha256Buffer(buf);
          checksums[relKey] = fileHash;
          filesMap[relKey] = buf.toString('base64');
        }
        mediaEntries.push({
          id: mediaId,
          originalName: m.originalName,
          sizeBytes: m.sizeBytes,
          sha256: fileHash || m.fingerprint,
          included: hasFile,
          ext,
        });
      }

      const manifest: CwpackManifest = CwpackManifestSchema.parse({
        format: 'cwpack',
        formatVersion: 1,
        schemaVersion: project.schemaVersion,
        appVersion: '1.0.0',
        createdAt: new Date().toISOString(),
        projectId: project.id,
        name: project.name,
        media: mediaEntries,
        fonts: [],
        brandKits: [],
        checksums,
      });

      const bundle = {
        manifest,
        files: filesMap,
      };
      const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
      fs.mkdirSync(path.dirname(destPackPath), { recursive: true });
      fs.writeFileSync(destPackPath, compressed);

      return {
        packPath: destPackPath,
        packageSha256: this.sha256Buffer(compressed),
        manifest,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  public importProjectPackage(
    packPath: string,
    opts?: { conflictMode?: 'copy' | 'replace' }
  ): { project: ProjectRecord; readOnly: boolean; reusedMediaIds: string[] } {
    if (!fs.existsSync(packPath)) {
      throw new Error(`Package file not found: ${packPath}`);
    }

    let rawJson: string;
    try {
      rawJson = zlib.gunzipSync(fs.readFileSync(packPath)).toString('utf8');
    } catch {
      throw new Error('The project package is damaged or not a valid .cwpack archive.');
    }

    const bundle = JSON.parse(rawJson) as {
      manifest: unknown;
      files: Record<string, string>;
    };
    const manifest = CwpackManifestSchema.parse(bundle.manifest);

    // Verify all checksums (Spec 03 §10.3 & §16.8)
    for (const [relKey, expectedHash] of Object.entries(manifest.checksums)) {
      const b64 = bundle.files[relKey];
      if (!b64) {
        throw new Error(`Package checksum verification failed: missing entry ${relKey}`);
      }
      const actualHash = this.sha256Buffer(Buffer.from(b64, 'base64'));
      if (actualHash !== expectedHash) {
        throw new Error(`Package checksum mismatch for ${relKey}: package appears tampered.`);
      }
    }

    const existing = this.getProject(manifest.projectId);
    const conflictMode = opts?.conflictMode ?? 'copy';
    const targetProjectId =
      existing && conflictMode === 'copy' ? uuidv7() : manifest.projectId;
    const targetName =
      existing && conflictMode === 'copy' ? `${manifest.name} (Imported)` : manifest.name;

    if (existing && conflictMode === 'replace') {
      this.createRestorePoint(manifest.projectId, 'Before package replace', true);
      this.closeProjectDb(manifest.projectId);
    }

    const reusedMediaIds: string[] = [];
    const mediaIdMap = new Map<string, string>();

    for (const mEntry of manifest.media) {
      const existingByHash = mEntry.sha256
        ? this.findMediaBySha256OrFingerprint(mEntry.sha256)
        : undefined;
      if (existingByHash && fs.existsSync(existingByHash.path)) {
        reusedMediaIds.push(existingByHash.id);
        mediaIdMap.set(mEntry.id, existingByHash.id);
        continue;
      }

      const relKey = `media/${mEntry.id}/original${mEntry.ext}`;
      const b64 = bundle.files[relKey];
      const mediaFolder = path.join(this.workspaceDir, 'Media', mEntry.id);
      fs.mkdirSync(mediaFolder, { recursive: true });
      const destMediaPath = path.join(mediaFolder, `original${mEntry.ext}`);

      let status: 'ok' | 'missing' = 'missing';
      if (mEntry.included && b64) {
        fs.writeFileSync(destMediaPath, Buffer.from(b64, 'base64'));
        status = 'ok';
      }

      if (!this.getMedia(mEntry.id)) {
        this.saveMedia({
          id: mEntry.id,
          kind: 'video',
          storageMode: 'managed',
          path: destMediaPath,
          originalName: mEntry.originalName,
          sizeBytes: mEntry.sizeBytes,
          sha256: mEntry.sha256,
          fingerprint: mEntry.sha256,
          createdAt: new Date().toISOString(),
          status,
          info: {
            mediaId: mEntry.id,
            kind: 'video',
            container: mEntry.ext.replace('.', '') || 'mp4',
            durationUs: 10_000_000,
            sizeBytes: mEntry.sizeBytes,
            hasSpeechAudio: true,
            audio: [],
            metadata: {},
          },
        });
      }
      mediaIdMap.set(mEntry.id, mEntry.id);
    }

    const projDir = this.getProjectDir(targetProjectId);
    fs.mkdirSync(projDir, { recursive: true });
    const dbFilePath = path.join(projDir, 'project.cwdb');
    fs.writeFileSync(dbFilePath, Buffer.from(bundle.files['project.cwdb'], 'base64'));

    const { db, readOnly } = this.openProjectDb(targetProjectId);
    const metaRow = db
      .prepare("SELECT value_json FROM meta WHERE key = 'project'")
      .get<{ value_json: string }>();
    const baseProj = metaRow ? JSON.parse(metaRow.value_json) : {};

    const importedProject = ProjectRecordSchema.parse({
      ...baseProj,
      id: targetProjectId,
      name: targetName,
      schemaVersion: manifest.schemaVersion,
      sourceMediaIds: manifest.media.map((m) => mediaIdMap.get(m.id) ?? m.id),
      updatedAt: new Date().toISOString(),
    });

    this.workspaceDb
      .prepare(
        `INSERT INTO projects (id, name, stage, archived, created_at, updated_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           stage = excluded.stage,
           updated_at = excluded.updated_at,
           payload_json = excluded.payload_json`
      )
      .run(
        importedProject.id,
        importedProject.name,
        importedProject.stage,
        importedProject.archived ? 1 : 0,
        importedProject.createdAt,
        importedProject.updatedAt,
        JSON.stringify(importedProject)
      );

    if (!readOnly) {
      db.prepare(
        `INSERT INTO meta (key, value_json) VALUES ('project', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      ).run(JSON.stringify(importedProject));
    }

    return { project: importedProject, readOnly, reusedMediaIds };
  }

  /* ==========================================================================
   * WORKSPACE RELOCATION & CACHE CLEANUP (Spec 03 §3.1 & §13)
   * ======================================================================== */
  public clearCache(): void {
    const cacheDir = path.join(this.workspaceDir, 'Cache');
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
    for (const sub of ['Cache', 'Cache/downloads', 'Cache/features', 'Cache/frames', 'Cache/waveforms']) {
      fs.mkdirSync(path.join(this.workspaceDir, sub), { recursive: true });
    }
  }

  public relocateWorkspace(
    targetDir: string,
    opts?: { onProgress?: (copiedBytes: number, totalBytes: number) => void; shouldCancel?: () => boolean }
  ): { movedTo: string; oldPath: string; fileCount: number } {
    const resolvedTarget = path.resolve(targetDir);
    if (resolvedTarget.startsWith(this.workspaceDir + path.sep) || resolvedTarget === this.workspaceDir) {
      throw new Error('Target folder cannot be inside the current workspace.');
    }

    // Flush and close open DBs before copying
    this.closeAll();

    try {
      this.initWorkspaceFolders(resolvedTarget);
      const filesToCopy: Array<{ src: string; dest: string; size: number }> = [];

      const collect = (relDir: string) => {
        if (relDir === 'Cache' || relDir.startsWith('Cache/')) return;
        const absDir = path.join(this.workspaceDir, relDir);
        if (!fs.existsSync(absDir)) return;
        for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
          const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
          if (childRel === 'Cache' || childRel.startsWith('Cache/')) continue;
          const srcPath = path.join(this.workspaceDir, childRel);
          const destPath = path.join(resolvedTarget, childRel);
          if (entry.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            collect(childRel);
          } else if (entry.isFile()) {
            const size = fs.statSync(srcPath).size;
            filesToCopy.push({ src: srcPath, dest: destPath, size });
          }
        }
      };
      collect('');

      const totalBytes = filesToCopy.reduce((acc, f) => acc + f.size, 0);
      let copiedBytes = 0;

      for (const file of filesToCopy) {
        if (opts?.shouldCancel?.()) {
          fs.rmSync(resolvedTarget, { recursive: true, force: true });
          throw new Error('Workspace relocation cancelled');
        }
        fs.mkdirSync(path.dirname(file.dest), { recursive: true });
        fs.copyFileSync(file.src, file.dest);
        copiedBytes += file.size;
        opts?.onProgress?.(copiedBytes, totalBytes);
      }

      // Verify SHA-256 of workspace.db and every project.cwdb (Spec 03 §13.3)
      for (const file of filesToCopy) {
        if (file.src.endsWith('.db') || file.src.endsWith('.cwdb')) {
          const srcHash = this.sha256File(file.src);
          const destHash = this.sha256File(file.dest);
          if (srcHash !== destHash) {
            throw new Error(`Checksum mismatch while relocating ${path.basename(file.src)}`);
          }
        }
      }

      const oldPath = this.workspaceDir;
      this.workspaceDir = resolvedTarget;
      this.logger.setLogsDir(path.join(this.workspaceDir, 'Logs'));
      this.openWorkspaceDatabase();
      return { movedTo: resolvedTarget, oldPath, fileCount: filesToCopy.length };
    } catch (err) {
      // Reopen original workspace if relocation failed or was cancelled
      this.openWorkspaceDatabase();
      throw err;
    }
  }
}
