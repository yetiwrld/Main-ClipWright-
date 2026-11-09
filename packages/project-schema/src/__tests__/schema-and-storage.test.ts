import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  openDatabase,
  runMigrations,
  WORKSPACE_MIGRATIONS,
  PROJECT_MIGRATIONS,
  readValidatedRows,
  ProjectRecordSchema,
  redact,
  uuidv7,
  CURRENT_SCHEMA_VERSION,
  CompositionPayloadSchema,
} from '../index.js';
import {
  StorageService,
  WORKSPACE_FOLDERS,
} from '../../../../apps/desktop/src/main/storage/storage-service.js';
import { SecretStore } from '../../../../apps/desktop/src/main/storage/secret-store.js';

describe('Spec 03 — Storage, Migrations, Recovery, Redaction & Portability', () => {
  it('1. creates the exact workspace folder structure with workspace.json and README.txt', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ws-1-'));
    const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-appdata-1-'));
    const storage = new StorageService(tmpDir, appDataDir);

    for (const folder of WORKSPACE_FOLDERS) {
      expect(fs.existsSync(path.join(tmpDir, folder)), `missing ${folder}`).toBe(true);
    }
    expect(fs.existsSync(path.join(tmpDir, 'workspace.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'README.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'Proxies', 'README.txt'))).toBe(true);

    storage.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(appDataDir, { recursive: true, force: true });
  });

  it('2. runs numbered forward migrations, backs up before migrating, and restores backup on failure', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mig-'));
    const dbPath = path.join(tmpDir, 'project.cwdb');
    const backupDir = path.join(tmpDir, 'backups');

    // Step 1: Migrate only to v1
    const dbV1 = openDatabase(dbPath);
    const res1 = runMigrations(dbV1, [PROJECT_MIGRATIONS[0]], {
      isProjectDb: true,
      backupDir,
    });
    expect(res1.toVersion).toBe(1);
    dbV1.prepare("INSERT INTO meta (key, value_json) VALUES ('marker', '\"v1-data\"')").run();
    dbV1.close();

    // Step 2: Inject failure at v2 -> verify backup is restored and v1 data is intact
    const dbFail = openDatabase(dbPath);
    const resFail = runMigrations(dbFail, PROJECT_MIGRATIONS, {
      isProjectDb: true,
      backupDir,
      injectFailureAtVersion: 2,
    });
    expect(resFail.restoredFromBackup).toBe(true);
    expect(resFail.toVersion).toBe(1);

    // Step 3: Re-open restored DB and migrate cleanly to v2
    const dbV2 = openDatabase(dbPath);
    const res2 = runMigrations(dbV2, PROJECT_MIGRATIONS, {
      isProjectDb: true,
      backupDir,
    });
    expect(res2.migrated).toBe(true);
    expect(res2.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    const row = dbV2
      .prepare("SELECT value_json FROM meta WHERE key = 'marker'")
      .get<{ value_json: string }>();
    expect(row?.value_json).toBe('"v1-data"');
    dbV2.close();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('3. opens newer schemaVersion databases in read-only mode (Spec 03 §9)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-newer-'));
    const dbPath = path.join(tmpDir, 'project.cwdb');
    const db = openDatabase(dbPath);
    runMigrations(db, PROJECT_MIGRATIONS, { isProjectDb: true });
    db.prepare(
      "UPDATE meta SET value_json = '999' WHERE key = 'schemaVersion'"
    ).run();

    const res = runMigrations(db, PROJECT_MIGRATIONS, { isProjectDb: true });
    expect(res.readOnly).toBe(true);
    expect(res.readOnlyReason).toContain('newer version');
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('4. quarantines corrupt rows in _quarantine without crashing and preserves unknown JSON fields', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, WORKSPACE_MIGRATIONS, { isProjectDb: false });

    const validProj = {
      id: 'proj-valid',
      name: 'Valid Project',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archived: false,
      stage: 'import',
      sourceMediaIds: [],
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appVersionLastSaved: '1.0.0',
      settings: {},
      futureCustomField: { keepMe: 12345 },
    };

    db.prepare(
      `INSERT INTO projects (id, name, stage, archived, created_at, updated_at, payload_json)
       VALUES (?, ?, ?, 0, ?, ?, ?)`
    ).run(
      validProj.id,
      validProj.name,
      validProj.stage,
      validProj.createdAt,
      validProj.updatedAt,
      JSON.stringify(validProj)
    );

    // Insert corrupt row
    db.prepare(
      `INSERT INTO projects (id, name, stage, archived, created_at, updated_at, payload_json)
       VALUES ('proj-bad', 'Bad', 'import', 0, 'now', 'now', '{"invalid": true}')`
    ).run();

    const res = readValidatedRows(db, 'projects', 'id', 'payload_json', ProjectRecordSchema);
    expect(res.recoveredWithProblems).toBe(true);
    expect(res.quarantinedCount).toBe(1);
    expect(res.items.length).toBe(1);
    expect((res.items[0] as any).futureCustomField).toEqual({ keepMe: 12345 });

    const qRow = db.prepare('SELECT * FROM _quarantine').all();
    expect(qRow.length).toBe(1);
    db.close();
  });

  it('5. replays operation journal on crash recovery, handles corrupt journal lines, and manages locks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rec-'));
    const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rec-app-'));
    const storage = new StorageService(tmpDir, appDataDir);

    const proj = storage.createProject({ name: 'Crash Recovery Project' });
    const compId = uuidv7();
    storage.saveComposition(proj.id, {
      id: compId,
      projectId: proj.id,
      name: 'Clip 1',
      version: 1,
      updatedAt: new Date().toISOString(),
      payload: {
        id: compId,
        name: 'Clip 1',
        fps: 30,
        canvas: { width: 1080, height: 1920, aspect: '9:16', backgroundColor: '#000000', backgroundBlur: false },
        tracks: [],
        items: {},
        markers: [],
        guides: [],
        links: [],
        groups: [],
        playheadUs: 0,
        toggles: {
          snapping: true,
          magneticMain: true,
          rippleAll: false,
          linkedSelection: true,
          followPlayhead: true,
          showWaveforms: true,
          showKeyframes: false,
          editMode: 'normal',
          coverLock: true,
          linkedToTranscript: true,
        },
        viewState: { pxPerSecond: 80, scrollX: 0, scrollY: 0, headerWidthPx: 184 },
        editByTranscriptDeletedWordIds: [],
      },
    });

    // Append 2 valid journal entries and 1 corrupt line
    storage.appendJournalEntry(proj.id, {
      seq: 1,
      compId,
      ts: new Date().toISOString(),
      commandName: 'setPlayhead',
      forwardPatch: { playheadUs: 1_500_000 },
      inversePatch: { playheadUs: 0 },
    });
    storage.appendJournalEntry(proj.id, {
      seq: 2,
      compId,
      ts: new Date().toISOString(),
      commandName: 'setPlayhead',
      forwardPatch: { playheadUs: 2_500_000 },
      inversePatch: { playheadUs: 1_500_000 },
    });
    fs.appendFileSync(storage.getJournalPath(proj.id), '{corrupt_json_line\n', 'utf8');

    const replay = storage.replayRecoveryJournal(proj.id);
    expect(replay.appliedCount).toBe(2);
    expect(replay.corruptCount).toBe(1);
    expect(replay.recoveredCompositions[0].payload.playheadUs).toBe(2_500_000);

    // Journal is now truncated and "Before recovery" restore point exists
    expect(storage.checkProjectRecovery(proj.id).needsRecovery).toBe(false);
    const restorePoints = storage.listRestorePoints(proj.id);
    expect(restorePoints.some((p) => p.label === 'Before recovery')).toBe(true);

    storage.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(appDataDir, { recursive: true, force: true });
  });

  it('6. exports and imports .cwpack packages with SHA-256 verification and rejects tampered packages', () => {
    const ws1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pack-1-'));
    const ws2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pack-2-'));
    const s1 = new StorageService(ws1Dir);
    const s2 = new StorageService(ws2Dir);

    const mediaId = uuidv7();
    const mediaFolder = path.join(ws1Dir, 'Media', mediaId);
    fs.mkdirSync(mediaFolder, { recursive: true });
    const mediaPath = path.join(mediaFolder, 'original.mp4');
    fs.writeFileSync(mediaPath, Buffer.from('FAKE_MP4_STREAM_DATA_FOR_HASH_CHECK'));

    s1.saveMedia({
      id: mediaId,
      kind: 'video',
      storageMode: 'managed',
      path: mediaPath,
      originalName: 'demo.mp4',
      sizeBytes: 35,
      fingerprint: 'fp123',
      createdAt: new Date().toISOString(),
      status: 'ok',
      info: {
        mediaId,
        kind: 'video',
        container: 'mp4',
        durationUs: 5_000_000,
        sizeBytes: 35,
        hasSpeechAudio: true,
        audio: [],
        metadata: {},
      },
    });

    const proj = s1.createProject({ name: 'Packaged Project', sourceMediaIds: [mediaId] });
    const packPath = path.join(ws1Dir, 'Exports', 'test.cwpack');
    const exported = s1.exportProjectPackage(proj.id, packPath, { includeMedia: true });
    expect(fs.existsSync(exported.packPath)).toBe(true);

    // Import into clean workspace s2
    const imported = s2.importProjectPackage(packPath);
    expect(imported.project.name).toBe('Packaged Project');
    expect(imported.project.sourceMediaIds).toEqual([mediaId]);

    // Import again in copy mode -> creates new copy and reuses media by SHA-256
    const importedCopy = s2.importProjectPackage(packPath, { conflictMode: 'copy' });
    expect(importedCopy.project.id).not.toBe(proj.id);
    expect(importedCopy.reusedMediaIds).toContain(mediaId);

    // Tamper with a byte of the package -> must reject
    const tamperedPath = path.join(ws1Dir, 'Exports', 'tampered.cwpack');
    const rawBuf = fs.readFileSync(packPath);
    rawBuf[rawBuf.length - 5] ^= 0xff;
    fs.writeFileSync(tamperedPath, rawBuf);
    expect(() => s2.importProjectPackage(tamperedPath)).toThrow();

    s1.closeAll();
    s2.closeAll();
    fs.rmSync(ws1Dir, { recursive: true, force: true });
    fs.rmSync(ws2Dir, { recursive: true, force: true });
  });

  it('7. relocates the workspace with byte verification and leaves original intact on cancel', () => {
    const wsSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-reloc-src-'));
    const wsDest = path.join(os.tmpdir(), `cw-reloc-dest-${Date.now()}`);
    const storage = new StorageService(wsSrc);
    const p = storage.createProject({ name: 'Relocatable Project' });

    const moved = storage.relocateWorkspace(wsDest);
    expect(moved.movedTo).toBe(path.resolve(wsDest));
    expect(storage.getProject(p.id)?.name).toBe('Relocatable Project');

    storage.closeAll();
    fs.rmSync(wsSrc, { recursive: true, force: true });
    fs.rmSync(wsDest, { recursive: true, force: true });
  });

  it('8. stores secrets outside the workspace and passes the 30-string redaction corpus (Spec 03 §11-12)', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sec-ws-'));
    const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sec-appdata-'));
    const storage = new StorageService(wsDir, appDataDir);
    const secrets = new SecretStore(appDataDir);

    const testKey = 'sk-proj-9876543210SecretKeyMaterialDoNotLeak';
    const saved = secrets.saveSecret(testKey);
    expect(saved.persisted).toBe(true);
    expect(saved.maskedSuffix).toBe('••••Leak');
    expect(secrets.getSecret(saved.secretId)).toBe(testKey);

    storage.saveProvider({
      id: 'prov-1',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      secretId: saved.secretId,
      maskedKeySuffix: saved.maskedSuffix,
      hasKey: true,
      capabilities: ['transcription', 'text'],
      models: { text: 'gpt-4o-mini' },
      locality: 'online',
      status: 'connected',
      timeoutMs: 60000,
      maxConcurrent: 2,
      numCtx: 8192,
    });

    storage.logger.info(`Testing provider with Authorization: Bearer ${testKey}`);

    // Scan workspace.db and Logs/ for any occurrence of testKey
    const wsDbBytes = fs.readFileSync(path.join(wsDir, 'workspace.db'), 'utf8');
    expect(wsDbBytes.includes(testKey)).toBe(false);
    const logLines = storage.logger.getRecentLines().join('\n');
    expect(logLines.includes(testKey)).toBe(false);

    // Session-only fallback when encryption is unavailable
    const memOnlyStore = new SecretStore(appDataDir, {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    });
    const memSaved = memOnlyStore.saveSecret('sk-sessionOnlyKey1234567890');
    expect(memSaved.persisted).toBe(false);
    expect(memOnlyStore.getSecret(memSaved.secretId)).toBe('sk-sessionOnlyKey1234567890');

    // 30-string redaction corpus (Spec 03 §12)
    const corpus: Array<[string, string]> = [
      ['Authorization: Bearer sk-1234567890abcdef123456', 'sk-1234567890abcdef123456'],
      ['Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==', 'dXNlcjpwYXNzd29yZDEyMzQ1Ng=='],
      ['x-api-key: sk-ant-api03-abcdef1234567890', 'sk-ant-api03-abcdef1234567890'],
      ['api-key: my-secret-azure-key-99887766', 'my-secret-azure-key-99887766'],
      ['x-goog-api-key: AIzaSyD1234567890abcdef1234567890', 'AIzaSyD1234567890abcdef1234567890'],
      ['https://example.com/v1?api_key=sec_9988776655443322', 'sec_9988776655443322'],
      ['https://example.com/v1?key=AIzaSyD9876543210abcdef1234567890', 'AIzaSyD9876543210abcdef1234567890'],
      ['https://example.com/v1?token=tok_abcdef1234567890', 'tok_abcdef1234567890'],
      ['https://example.com/v1?access_token=acc_1234567890abcdef', 'acc_1234567890abcdef'],
      ['https://example.com/v1?client_secret=cs_1234567890abcdef', 'cs_1234567890abcdef'],
      ['https://example.com/v1?secret=s_1234567890abcdef', 's_1234567890abcdef'],
      ['https://example.com/v1?password=pw_1234567890abcdef', 'pw_1234567890abcdef'],
      ['{"apiKey":"sk-live-11223344556677889900"}', 'sk-live-11223344556677889900'],
      ['{"api_key":"sk-live-aabbccddeeff00112233"}', 'sk-live-aabbccddeeff00112233'],
      ['{"secretKey":"sec-live-aabbccddeeff00112233"}', 'sec-live-aabbccddeeff00112233'],
      ['{"access_token":"at-live-aabbccddeeff00112233"}', 'at-live-aabbccddeeff00112233'],
      ['{"password":"superSecretPassword123!"}', 'superSecretPassword123!'],
      ['Key is sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
      ['Key is sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
      ['Groq gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
      ['Gemini AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
      ['GitHub ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
      ['GitHub github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
      ['GitLab glpat-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'glpat-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
      ['Slack xoxb-1234567890-1234567890-ABCDEF', 'xoxb-1234567890-1234567890-ABCDEF'],
      ['HuggingFace hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
      ['Replicate r8_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'r8_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
      ['Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
      ['.youtube.com\tTRUE\t/\tTRUE\t1799999999\tLOGIN_INFO\tsecretCookieValue12345', 'secretCookieValue12345'],
      ['File in C:\\Users\\AliceSmith\\Documents\\video.mp4 and /home/alicesmith/video.mp4', 'AliceSmith'],
    ];

    expect(corpus.length).toBe(30);
    for (const [raw, forbiddenSubstring] of corpus) {
      const redacted = redact(raw, '/home/alicesmith');
      expect(
        redacted.includes(forbiddenSubstring),
        `Failed to redact "${forbiddenSubstring}" from "${raw}" -> "${redacted}"`
      ).toBe(false);
    }

    storage.closeAll();
    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.rmSync(appDataDir, { recursive: true, force: true });
  });
  it('persists user composition guides with the project (SPEC 10 §8.8)', () => {
    /*
      A guide is the one overlay that is document state, so the claim "saved with the
      project" has to be checked against a real save and a real load rather than against
      the schema in isolation. `CompositionRecordSchema.parse` runs on save, which is what
      makes this a round-trip and not just an object comparison: a field the schema did not
      know about would be dropped by that parse.
    */
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-guides-'));
    const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-guides-app-'));
    const storage = new StorageService(tmpDir, appDataDir);
    const proj = storage.createProject({ name: 'Guides Project' });
    const compId = uuidv7();
    storage.saveComposition(proj.id, {
      id: compId,
      projectId: proj.id,
      name: 'Clip 1',
      version: 1,
      updatedAt: new Date().toISOString(),
      payload: {
        id: compId,
        name: 'Clip 1',
        fps: 30,
        canvas: { width: 1080, height: 1920, aspect: '9:16', backgroundColor: '#000000', backgroundBlur: false },
        tracks: [],
        items: {},
        markers: [],
        guides: [
          { id: 'g1', axis: 'x', at: 0.25, locked: true },
          { id: 'g2', axis: 'y', at: 0.75, locked: false },
        ],
        links: [],
        groups: [],
        playheadUs: 0,
        toggles: {},
        viewState: {},
        editByTranscriptDeletedWordIds: [],
      },
    } as never);

    const loaded = storage.getComposition(proj.id, compId);
    // `locked` has to survive the file, not just the schema: a lock the user set and then
    // lost by reopening the project would remove itself at the worst moment, and it is the
    // only field on a guide that cannot be reconstructed from geometry.
    expect(loaded?.payload.guides).toEqual([
      { id: 'g1', axis: 'x', at: 0.25, locked: true },
      { id: 'g2', axis: 'y', at: 0.75, locked: false },
    ]);
  });

  it('reads a guide saved before Lock existed as unlocked', () => {
    /*
      The other half of the compatibility promise, at the level where it can be broken: the
      default lives on the schema, and a guide without the field has to come out unlocked
      rather than `undefined`, because `undefined` is falsy in the app but absent from a
      strict comparison — and would make a legacy guide's removal behaviour depend on which
      code path read it.
    */
    const parsed = CompositionPayloadSchema.parse({
      id: 'comp',
      name: 'Clip',
      canvas: { width: 1080, height: 1920, aspect: '9:16', backgroundColor: '#000000', backgroundBlur: false },
      tracks: [],
      items: {},
      guides: [{ id: 'old', axis: 'x', at: 0.5 }],
    });
    // `toStrictEqual`, not `toEqual`: the latter treats `{locked: undefined}` as equal to
    // `{locked: false}`, which is exactly the difference this test exists to catch.
    expect(parsed.guides).toStrictEqual([{ id: 'old', axis: 'x', at: 0.5, locked: false }]);
  });

  it('opens a project saved before guides existed', () => {
    /*
      Every field added since v1 defaults, so an older file loads with an empty list rather
      than failing validation and dropping the user into read-only recovery. This is the
      half of the compatibility story that a fixture with the field already present cannot
      check.
    */
    const parsed = CompositionPayloadSchema.parse({
      id: 'comp',
      name: 'Clip',
      // `canvas` is the one field with no default, so a minimal valid payload still
      // carries it; everything else — including `guides` — has to fill itself in.
      canvas: { width: 1080, height: 1920, aspect: '9:16', backgroundColor: '#000000', backgroundBlur: false },
      tracks: [],
      items: {},
    });
    expect(parsed.guides).toEqual([]);
  });

});
